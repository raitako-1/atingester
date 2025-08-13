import { check, createDeferrable, type Deferrable, schema, wait } from '@atproto/common'
import { ipldToLex } from '@atproto/lexicon'
import type { FirehoseOptions } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import {
  WebSocketKeepAlive,
} from '@atproto/xrpc-server'
import { createDCtx, decompressUsingDict, init } from '@bokuweb/zstd-wasm'
import { CID } from 'multiformats/cid'
import { type ClientOptions } from 'ws'
import {
  parseAccount,
  parseIdentity,
} from './firehose'
import type { JetstreamCommitEvt, JetstreamCommitMeta, JetstreamEvent, JetstreamEventKind, JetstreamEventKindCommit } from '../types'

export type JetstreamOptions = Omit<FirehoseOptions, 'handleEvent' | 'unauthenticatedCommits' | 'excludeSync'> & {
  compress?: boolean
  filterDids?: string[]
  handleEvent: (evt: JetstreamEvent) => Awaited<void>
  onInfo: (info: string) => void
}

export class Jetstream {
  private sub: JetstreamSubscription<JetstreamEventKind>
  private abortController: AbortController
  private destoryDefer: Deferrable

  constructor(public opts: JetstreamOptions) {
    this.destoryDefer = createDeferrable()
    this.abortController = new AbortController()
    if (this.opts.getCursor && this.opts.runner) {
      throw new Error('Must set only `getCursor` or `runner`')
    }
    this.sub = new JetstreamSubscription({
      ...opts,
      service: opts.service ?? 'wss://jetstream1.us-east.bsky.network',
      method: 'subscribe',
      signal: this.abortController.signal,
      getParams: async () => {
        const getCursorFn = this.opts.runner?.getCursor ?? this.opts.getCursor
        const cursor = await getCursorFn?.()
        return {
          wantedCollections: this.opts.filterCollections,
          wantedDids: this.opts.filterDids,
          cursor,
          compress: this.opts.compress,
        }
      },
      validate: (value: unknown) => {
        try {
          return value as JetstreamEventKind // TODO validate??
        } catch (err) {
          this.opts.onError(new JetstreamValidationError(err, value))
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
      if (err && err['name'] === 'AbortError') {
        this.destoryDefer.resolve()
        return
      }
      this.opts.onError(new JetstreamSubscriptionError(err))
      await wait(this.opts.subscriptionReconnectDelay ?? 3000)
      return this.start()
    }
  }

  private async parseEvt(evt: JetstreamEventKind): Promise<JetstreamEvent | null> {
    try {
      if (evt.kind === 'commit' && !this.opts.excludeCommit) {
        return await parseJetstreamKindCommitUnauthenticated(evt, this.opts.filterCollections ?? [], this.opts.filterDids ?? [])
      } else if (evt.kind === 'account' && !this.opts.excludeAccount) {
        const parsed = parseAccount(evt.account)
        return parsed ? {...parsed, time_us: evt.time_us} : null
      } else if (evt.kind === 'identity' && !this.opts.excludeIdentity) {
        const parsed = await parseIdentity(
          this.opts.idResolver,
          evt.identity,
          this.opts.unauthenticatedHandles,
        )
        return parsed ? {...parsed, time_us: evt.time_us} : null
      } else {
        return null
      }
    } catch (err) {
      this.opts.onError(new JetstreamParseError(err, evt))
      return null
    }
  }

  private async processEvt(evt: JetstreamEventKind) {
    const parsed = await this.parseEvt(evt)
    if (parsed) {
      try {
        await this.opts.handleEvent(parsed)
      } catch (err) {
        this.opts.onError(new JetstreamHandlerError(err, parsed))
      }
    }
  }

  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.destoryDefer.complete
  }
}

export class JetstreamSubscription<T = unknown> {
  constructor(
    public opts: ClientOptions & {
      service: string
      method: string
      maxReconnectSeconds?: number
      heartbeatIntervalMs?: number
      signal?: AbortSignal
      compress?: boolean
      onInfo: (info: string) => void
      onError: (err: Error) => void
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
    const ws = new WebSocketKeepAlive({
      ...this.opts,
      getUrl: async () => {
        const params = (await this.opts.getParams?.()) ?? {}
        const query = encodeQueryParams(params)
        const url = `${this.opts.service}/${this.opts.method}?${query}`
        this.opts.onInfo(`Jetstream: ${url}`)
        return url
      },
    })
    await init()
    const res = await fetch('https://raw.githubusercontent.com/bluesky-social/jetstream/refs/heads/main/pkg/models/zstd_dictionary')
    const dict = new Uint8Array(await res.arrayBuffer())
    for await (const chunk of ws) {
      try {
        if (this.opts.compress) {
          const decompressed = decompressUsingDict(createDCtx(), chunk, dict)
          const record = JSON.parse(Buffer.from(decompressed).toString())
          yield record
        } else {
          const record = JSON.parse(Buffer.from(chunk).toString())
          yield record
        }
      } catch (err) {
        this.opts.onError(new JetstreamDecompressError(err))
      }
    }
  }
}

function encodeQueryParams(obj: Record<string, unknown>): string {
  const params = new URLSearchParams()
  Object.entries(obj).forEach(([key, value]) => {
    const encoded = encodeQueryParam(value)
    if (Array.isArray(encoded)) {
      encoded.forEach((enc) => params.append(key, enc))
    } else {
      if (encoded) params.set(key, encoded)
    }
  })
  return params.toString()
}

// Adapted from xrpc, but without any lex-specific knowledge
function encodeQueryParam(value: unknown): string | string[] {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return value.toString()
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'undefined') {
    return ''
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return value.toISOString()
    } else if (Array.isArray(value)) {
      return value.flatMap(encodeQueryParam)
    } else if (!value) {
      return ''
    }
  }
  throw new Error(`Cannot encode ${typeof value}s into query params`)
}

export const parseJetstreamKindCommitUnauthenticated = async (
  evt: JetstreamEventKindCommit,
  filterCollections: string[],
  filterDids: string[],
): Promise<JetstreamCommitEvt | null> => {
  if ((filterCollections.length === 0 || filterCollections.includes(evt.commit.collection)) && (filterDids.length === 0 || filterDids.includes(evt.did))) {
    return formatCommitEvt(evt)
  }
  return null
}

const formatCommitEvt = async (evt: JetstreamEventKindCommit): Promise<JetstreamCommitEvt | null> => {
  const meta: JetstreamCommitMeta = {
    time_us: evt.time_us,
    time: new Date(evt.time_us/(10**3)).toISOString(),
    rev: evt.commit.rev,
    uri: AtUri.make(evt.did, `${evt.commit.collection}/${evt.commit.rkey}`),
    did: evt.did,
    collection: evt.commit.collection,
    rkey: evt.commit.rkey,
  }

  if (evt.commit.operation === 'create' || evt.commit.operation === 'update') {
    const cid = CID.parse(evt.commit.cid)
    const record = ipldToLex(evt.commit.record)
    if (!check.is(record, schema.map)) {
      throw new Error('lexicon records be a json object')
    }
    return {
      ...meta,
      event: evt.commit.operation as 'create' | 'update',
      cid,
      record,
    }
  }

  if (evt.commit.operation === 'delete') {
    return {
      ...meta,
      event: 'delete',
    }
  }

  return null
}

export class JetstreamValidationError extends Error {
  constructor(
    err: unknown,
    public value: unknown,
  ) {
    super('error in jetstream event lexicon validation', { cause: err })
  }
}

export class JetstreamParseError extends Error {
  constructor(
    err: unknown,
    public event: JetstreamEventKind,
  ) {
    super('error in parsing and authenticating jetstream event', { cause: err })
  }
}

export class JetstreamSubscriptionError extends Error {
  constructor(err: unknown) {
    super('error on jetstream subscription', { cause: err })
  }
}

export class JetstreamHandlerError extends Error {
  constructor(
    err: unknown,
    public event: JetstreamEvent,
  ) {
    super('error in jetstream event handler', { cause: err })
  }
}

export class JetstreamDecompressError extends Error {
  constructor(err: unknown) {
    super('error in jetstream subscription', { cause: err })
  }
}
