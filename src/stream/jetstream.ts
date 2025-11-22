import { check, createDeferrable, type Deferrable, schema, wait } from '@atproto/common'
import { ipldToLex } from '@atproto/lexicon'
import type { FirehoseOptions } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import { WebSocketKeepAlive } from '@atproto/ws-client'
import { createDCtx, decompressUsingDict, freeDCtx } from '@bokuweb/zstd-wasm'
import fs from 'fs'
import { CID } from 'multiformats/cid'
import path from 'path'
import { type ClientOptions } from 'ws'
import {
  parseAccount,
  parseIdentity,
} from './firehose'
import type { JetstreamCommitEvt, JetstreamCommitMeta, JetstreamEvent, JetstreamEventKind, JetstreamEventKindCommit } from '../types'
import { encodeQueryParams } from './util'

const dict = fs.readFileSync(path.resolve(__dirname, '../../dict/zstd_dictionary'))

export type JetstreamOptions = Omit<FirehoseOptions,
  | 'handleEvent'
  | 'unauthenticatedCommits'
  | 'excludeSync'
> & {
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
      signal: this.abortController.signal,
      getParams: async () => {
        const getCursorFn = this.opts.runner?.getCursor ?? this.opts.getCursor
        const cursor = await getCursorFn?.()
        const wantedCollections = this.opts.excludeCommit ? undefined : this.opts.filterCollections
        const wantedDids = (this.opts.excludeIdentity && this.opts.excludeAccount && this.opts.excludeCommit) ? undefined : this.opts.filterDids
        const onlyCommit = (this.opts.excludeIdentity && this.opts.excludeAccount && !this.opts.excludeCommit) ? true : undefined
        return {
          wantedCollections,
          wantedDids,
          excludeIdentity: this.opts.excludeIdentity,
          excludeAccount: this.opts.excludeAccount,
          excludeCommit: this.opts.excludeCommit,
          onlyCommit,
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
        const url = `${this.opts.service}/subscribe?${query}`
        this.opts.onInfo(`Jetstream: ${url}`)
        return url
      },
    })
    for await (const chunk of ws) {
      try {
        if (this.opts.compress) {
          const dctx = createDCtx()
          const decompressed = decompressUsingDict(dctx, chunk, dict)
          freeDCtx(dctx)
          const record = JSON.parse(Buffer.from(decompressed).toString())
          yield record
        } else {
          const record = JSON.parse(Buffer.from(chunk).toString())
          yield record
        }
      } catch (err) {
        this.opts.onError(new JetstreamConverterError(err))
      }
    }
  }
}

export const parseJetstreamKindCommitUnauthenticated = async (
  evt: JetstreamEventKindCommit,
  filterCollections: string[],
  filterDids: string[],
): Promise<JetstreamCommitEvt | null> => {
  if ((filterCollections.length === 0 || filterCollections.includes(evt.commit.collection)) && (filterDids.length === 0 || filterDids.includes(evt.did))) {
    return formatJetstreamCommitEvt(evt)
  }
  return null
}

const formatJetstreamCommitEvt = async (evt: JetstreamEventKindCommit): Promise<JetstreamCommitEvt | null> => {
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

export class JetstreamConverterError extends Error {
  constructor(err: unknown) {
    super('error in jetstream event converter', { cause: err })
  }
}
