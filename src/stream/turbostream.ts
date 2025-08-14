import { check, createDeferrable, type Deferrable, schema, wait } from '@atproto/common'
import { ipldToLex } from '@atproto/lexicon'
import type { FirehoseOptions } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import {
  WebSocketKeepAlive,
} from '@atproto/xrpc-server'
import { CID } from 'multiformats/cid'
import { type ClientOptions } from 'ws'
import type { TurbostreamCommitEvt, TurbostreamCommitMeta, TurbostreamEventKind } from '../types'

export type TurbostreamOptions = Omit<FirehoseOptions,
  | 'idResolver'
  | 'handleEvent'
  | 'getCursor'
  | 'runner'
  | 'unauthenticatedCommits'
  | 'unauthenticatedHandles'
  | 'filterCollections'
  | 'excludeIdentity'
  | 'excludeAccount'
  | 'excludeSync'
> & {
  handleEvent: (evt: TurbostreamCommitEvt) => Awaited<void>
  onInfo: (info: string) => void
}

export class Turbostream {
  private sub: TurbostreamSubscription<TurbostreamEventKind>
  private abortController: AbortController
  private destoryDefer: Deferrable

  constructor(public opts: TurbostreamOptions) {
    this.destoryDefer = createDeferrable()
    this.abortController = new AbortController()
    this.sub = new TurbostreamSubscription({
      ...opts,
      service: opts.service ?? 'wss://api.graze.social',
      method: 'turbostream',
      signal: this.abortController.signal,
      validate: (value: unknown) => {
        try {
          return value as TurbostreamEventKind // TODO validate??
        } catch (err) {
          this.opts.onError(new TurbostreamValidationError(err, value))
        }
      },
    })
  }

  async start(): Promise<void> {
    try {
      for await (const evt of this.sub) {
        await this.processEvt(evt)
      }
    } catch (err) {
      if (err && err['name'] === 'AbortError') {
        this.destoryDefer.resolve()
        return
      }
      this.opts.onError(new TurbostreamSubscriptionError(err))
      await wait(this.opts.subscriptionReconnectDelay ?? 3000)
      return this.start()
    }
  }

  private async parseEvt(evt: TurbostreamEventKind): Promise<TurbostreamCommitEvt | null> {
    try {
      if (evt.message.kind === 'commit' && !this.opts.excludeCommit) {
        return await formatCommitEvt(evt)
      } else {
        return null
      }
    } catch (err) {
      this.opts.onError(new TurbostreamParseError(err, evt))
      return null
    }
  }

  private async processEvt(evt: TurbostreamEventKind) {
    const parsed = await this.parseEvt(evt)
    if (parsed) {
      try {
        await this.opts.handleEvent(parsed)
      } catch (err) {
        this.opts.onError(new TurbostreamHandlerError(err, parsed))
      }
    }
  }

  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.destoryDefer.complete
  }
}

export class TurbostreamSubscription<T = unknown> {
  constructor(
    public opts: ClientOptions & {
      service: string
      method: string
      maxReconnectSeconds?: number
      heartbeatIntervalMs?: number
      signal?: AbortSignal
      onInfo: (info: string) => void
      onError: (err: Error) => void
      validate: (obj: unknown) => T | undefined
      onReconnectError?: (
        error: unknown,
        n: number,
        initialSetup: boolean,
      ) => void
    },
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    const ws = new WebSocketKeepAlive({
      ...this.opts,
      getUrl: async () => {
        const url = `${this.opts.service}/app/api/v1/turbostream/${this.opts.method}`
        this.opts.onInfo(`Turbostream: ${url}`)
        return url
      },
    })
    for await (const chunk of ws) {
      try {
        const record = JSON.parse(Buffer.from(chunk).toString())
        yield record
      } catch (err) {
        this.opts.onError(new TurbostreamDecompressError(err))
      }
    }
  }
}

const formatCommitEvt = async (evt: TurbostreamEventKind): Promise<TurbostreamCommitEvt | null> => {
  const meta: TurbostreamCommitMeta = {
    time_us: evt.message.time_us,
    time: new Date(evt.message.time_us/(10**3)).toISOString(),
    rev: evt.message.commit.rev,
    uri: AtUri.make(evt.did, `${evt.message.commit.collection}/${evt.message.commit.rkey}`),
    did: evt.did,
    collection: evt.message.commit.collection,
    rkey: evt.message.commit.rkey,
    hydrated_metadata: evt.hydrated_metadata,
  }

  if (evt.message.commit.operation === 'create' || evt.message.commit.operation === 'update') {
    const cid = CID.parse(evt.message.commit.cid)
    const record = ipldToLex(evt.message.commit.record)
    if (!check.is(record, schema.map)) {
      throw new Error('lexicon records be a json object')
    }
    return {
      ...meta,
      event: evt.message.commit.operation as 'create' | 'update',
      cid,
      record,
    }
  }

  if (evt.message.commit.operation === 'delete') {
    return {
      ...meta,
      event: 'delete',
    }
  }

  return null
}

export class TurbostreamValidationError extends Error {
  constructor(
    err: unknown,
    public value: unknown,
  ) {
    super('error in turbostream event lexicon validation', { cause: err })
  }
}

export class TurbostreamParseError extends Error {
  constructor(
    err: unknown,
    public event: TurbostreamEventKind,
  ) {
    super('error in parsing and authenticating turbostream event', { cause: err })
  }
}

export class TurbostreamSubscriptionError extends Error {
  constructor(err: unknown) {
    super('error on turbostream subscription', { cause: err })
  }
}

export class TurbostreamHandlerError extends Error {
  constructor(
    err: unknown,
    public event: TurbostreamCommitEvt,
  ) {
    super('error in turbostream event handler', { cause: err })
  }
}

export class TurbostreamDecompressError extends Error {
  constructor(err: unknown) {
    super('error in turbostream subscription', { cause: err })
  }
}
