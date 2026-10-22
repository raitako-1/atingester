import { check, createDeferrable, type Deferrable, schema, wait } from '@atproto/common'
import { jsonToLex, parseCid } from '@atproto/lex'
import type { FirehoseOptions } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import { type HeadersInit, websocket } from '@atproto/ws-client'
import { createDCtx, decompressUsingDict, freeDCtx } from '@bokuweb/zstd-wasm'
import fs from 'fs'
import path from 'path'
import {
  parseAccount,
  parseIdentity,
} from './firehose.js'
import type { JetstreamV1CommitEvt, JetstreamV1CommitMeta, JetstreamV1Event, JetstreamV1EventKind, JetstreamV1EventKindCommit } from '../types.js'
import { encodeQueryParams } from './util.js'

const dict = fs.readFileSync(path.resolve(import.meta.dirname, '../../dict/zstd_dictionary'))

export type JetstreamV1Options = Omit<FirehoseOptions,
  | 'handleEvent'
  | 'unauthenticatedCommits'
  | 'excludeSync'
> & {
  compress?: boolean
  filterDids?: string[]
  handleEvent: (evt: JetstreamV1Event) => void | Promise<void>
  onInfo: (info: string) => void
}

export class JetstreamV1 {
  private sub: JetstreamV1Subscription<JetstreamV1EventKind>
  private abortController: AbortController
  private destoryDefer: Deferrable
  private matchCollection: ((col: string) => boolean) | null = null
  private matchDid: ((did: string) => boolean) | null = null

  constructor(public opts: JetstreamV1Options) {
    this.destoryDefer = createDeferrable()
    this.abortController = new AbortController()
    if (this.opts.getCursor && this.opts.runner) {
      throw new Error('Must set only `getCursor` or `runner`')
    }
    if (opts.filterCollections) {
      const exact = new Set<string>()
      const prefixes = new Set<string>()

      for (const pattern of opts.filterCollections) {
        if (pattern.endsWith('.*')) {
          prefixes.add(pattern.slice(0, -2))
        } else {
          exact.add(pattern)
        }
      }
      this.matchCollection = (col: string): boolean => {
        if (exact.has(col)) return true
        for (const prefix of prefixes) {
          if (col.startsWith(prefix)) return true
        }
        return false
      }
    }
    if (opts.filterDids) {
      const exact = new Set<string>()

      for (const pattern of opts.filterDids) {
        exact.add(pattern)
      }
      this.matchDid = (did: string): boolean => {
        if (exact.has(did)) return true
        return false
      }
    }
    // Listed explicitly rather than spread: the old `ClientOptions &` shape let
    // arbitrary `ws` options through, which Subscription no longer accepts — a
    // spread would silently drop them.
    this.sub = new JetstreamV1Subscription({
      service: opts.service ?? 'wss://jetstream1.us-west.bsky.network',
      method: 'subscribe',
      maxReconnectSeconds: opts.maxReconnectSeconds,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      headers: opts.headers,
      signal: this.abortController.signal,
      compress: opts.compress,
      onInfo: opts.onInfo,
      getParams: async () => {
        const getCursorFn = this.opts.runner?.getCursor ?? this.opts.getCursor
        const cursor = await getCursorFn?.()
        const wantedCollections = this.opts.excludeCommit ? undefined : this.opts.filterCollections
        const wantedDids = (this.opts.excludeIdentity && this.opts.excludeAccount && this.opts.excludeCommit) ? undefined : this.opts.filterDids
        const onlyCommit = (this.opts.excludeIdentity && this.opts.excludeAccount && !this.opts.excludeCommit) ? true : undefined
        const params = {
          wantedCollections,
          wantedDids,
          excludeIdentity: this.opts.excludeIdentity,
          excludeAccount: this.opts.excludeAccount,
          excludeCommit: this.opts.excludeCommit,
          onlyCommit,
          cursor,
          compress: this.opts.compress,
        }
        return Object.fromEntries(Object.entries(params).filter(([k, v]) => v !== undefined))
      },
      validate: (value: unknown) => {
        try {
          return value as JetstreamV1EventKind // TODO validate??
        } catch (err) {
          this.opts.onError(new JetstreamV1ValidationError(err, value))
        }
      },
    })
  }

  async start(): Promise<void> {
    try {
      for await (const evt of this.sub) {
        if (this.opts.runner) {
          this.opts.runner.trackEvent(evt.did, evt.time_us, async () => {
            await this.processEvt(evt)
          })
        } else {
          await this.processEvt(evt)
        }
      }
    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        this.destoryDefer.resolve()
        return
      }
      this.opts.onError(new JetstreamV1SubscriptionError(err))
      await wait(this.opts.subscriptionReconnectDelay ?? 3000)
      return this.start()
    }
  }

  private async parseEvt(evt: JetstreamV1EventKind): Promise<JetstreamV1Event[]> {
    try {
      if (evt.kind === 'commit') {
        if (this.opts.excludeCommit) return []

        return await parseJetstreamV1KindCommitUnauthenticated(evt, this.matchCollection, this.matchDid)
      } else if (evt.kind === 'account') {
        if (this.opts.excludeAccount) return []

        const parsed = parseAccount(evt.account, this.matchDid)
        return parsed ? [{...parsed, time_us: evt.time_us, cursor: evt.cursor}] : []
      } else if (evt.kind === 'identity') {
        if (this.opts.excludeIdentity) return []

        const parsed = await parseIdentity(
          this.opts.idResolver,
          evt.identity,
          this.matchDid,
          this.opts.unauthenticatedHandles,
        )
        return parsed ? [{...parsed, time_us: evt.time_us, cursor: evt.cursor}] : []
      } else {
        return []
      }
    } catch (err) {
      this.opts.onError(new JetstreamV1ParseError(err, evt))
      return []
    }
  }

  private async processEvt(evt: JetstreamV1EventKind) {
    const parsed = await this.parseEvt(evt)
    for (const write of parsed) {
      try {
        await this.opts.handleEvent(write)
      } catch (err) {
        this.opts.onError(new JetstreamV1HandlerError(err, write))
      }
    }
  }

  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.destoryDefer.complete
  }
}

class JetstreamV1Subscription<T = unknown> {
  constructor(
    public opts: {
      service: string
      method: string
      maxReconnectSeconds?: number
      heartbeatIntervalMs?: number
      /** Applied to the connection's upgrade request (Node.js only). */
      headers?: HeadersInit
      signal?: AbortSignal
      compress?: boolean
      onInfo: (info: string) => void
      validate: (obj: unknown) => T | undefined
      onReconnectError?: (
        error: unknown,
        n: number,
        initialSetup: boolean,
      ) => void
      getParams?: () =>
        | Record<string, unknown>
        | Promise<Record<string, unknown> | undefined>
        | undefined
    },
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    const ws = websocket(
      async () => {
        const params = (await this.opts.getParams?.()) ?? {}
        const query = encodeQueryParams(params)
        const url = `${this.opts.service}/${this.opts.method}?${query}`
        this.opts.onInfo(`Jetstream v1: ${url}`)
        return url
      },
      {
        // Subscription frames are CBOR.
        dataMode: this.opts.compress ? 'binary' : 'text',
        headers: this.opts.headers,
        maxReconnectSeconds: this.opts.maxReconnectSeconds,
        // `{}` means "on at the default interval". Omitting the option entirely
        // would also default it on, but being explicit keeps the intent visible
        // next to the caller-supplied override.
        heartbeat: this.opts.heartbeatIntervalMs
          ? { intervalMs: this.opts.heartbeatIntervalMs }
          : {},
        signal: this.opts.signal,
        // Only retries are reported: a fatal error reaches the consumer as the
        // iterator's rejection instead. `initialSetup` now means "first attempt of
        // this reconnect cycle" rather than "before the first-ever successful
        // connection".
        onReconnect: (error, { attempt }) => {
          this.opts.onReconnectError?.(error, attempt, attempt === 0)
        },
      },
    )
    for await (const chunk of ws) {
      if (this.opts.compress) {
        const dctx = createDCtx()
        const decompressed = decompressUsingDict(dctx, chunk as Uint8Array<ArrayBuffer>, dict)
        freeDCtx(dctx)
        const record = JSON.parse(Buffer.from(decompressed).toString())
        yield record
      } else {
        const record = JSON.parse(Buffer.from(chunk).toString())
        yield record
      }
    }
  }
}

const parseJetstreamV1KindCommitUnauthenticated = async (
  evt: JetstreamV1EventKindCommit,
  matchCollection: ((col: string) => boolean) | null,
  matchDid: ((did: string) => boolean) | null,
): Promise<JetstreamV1CommitEvt[]> => {
  if (!matchCollection) matchCollection = () => true
  if (!matchDid) matchDid = () => true
  if (matchCollection(evt.commit.collection) && matchDid(evt.did)) {
    return await formatJetstreamV1CommitEvts(evt)
  }
  return []
}

const formatJetstreamV1CommitEvts = async (evt: JetstreamV1EventKindCommit): Promise<JetstreamV1CommitEvt[]> => {
  const meta: JetstreamV1CommitMeta = {
    time_us: evt.time_us,
    cursor: evt.cursor,
    seq: evt.time_us,
    time: new Date(evt.time_us/(10**3)).toISOString(),
    rev: evt.commit.rev,
    uri: AtUri.make(evt.did, `${evt.commit.collection}/${evt.commit.rkey}`),
    did: evt.did,
    collection: evt.commit.collection,
    rkey: evt.commit.rkey,
  }

  if (evt.commit.operation === 'create' || evt.commit.operation === 'update') {
    const cid = parseCid(evt.commit.cid)
    const record = jsonToLex(evt.commit.record)
    if (!check.is(record, schema.map)) {
      throw new Error('lexicon records be a json object')
    }
    return [{
      ...meta,
      event: evt.commit.operation,
      cid,
      record,
    }]
  }

  if (evt.commit.operation === 'delete') {
    return [{
      ...meta,
      event: 'delete',
    }]
  }

  return []
}

export class JetstreamV1ValidationError extends Error {
  constructor(
    err: unknown,
    public value: unknown,
  ) {
    super('error in jetstream event lexicon validation', { cause: err })
  }
}

export class JetstreamV1ParseError extends Error {
  constructor(
    err: unknown,
    public event: JetstreamV1EventKind,
  ) {
    super('error in parsing and authenticating jetstream event', { cause: err })
  }
}

export class JetstreamV1SubscriptionError extends Error {
  constructor(err: unknown) {
    super('error on jetstream subscription', { cause: err })
  }
}

export class JetstreamV1HandlerError extends Error {
  constructor(
    err: unknown,
    public event: JetstreamV1Event,
  ) {
    super('error in jetstream event handler', { cause: err })
  }
}

export class JetstreamV1ConverterError extends Error {
  constructor(err: unknown) {
    super('error in jetstream event converter', { cause: err })
  }
}
