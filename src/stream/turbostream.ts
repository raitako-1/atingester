import { check, createDeferrable, type Deferrable, schema, wait } from '@atproto/common'
import { jsonToLex, parseCid } from '@atproto/lex'
import type { FirehoseOptions } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import { type HeadersInit, websocket } from '@atproto/ws-client'
import type { TurbostreamCommitEvt, TurbostreamCommitMeta, TurbostreamEventKind } from '../types.js'

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
  | 'excludeCommit'
  | 'excludeSync'
> & {
  filterDids?: string[]
  handleEvent: (evt: TurbostreamCommitEvt) => void | Promise<void>
  onInfo: (info: string) => void
}

export class Turbostream {
  private sub: TurbostreamSubscription<TurbostreamEventKind>
  private abortController: AbortController
  private destoryDefer: Deferrable
  private matchDid: ((did: string) => boolean) | null = null

  constructor(public opts: TurbostreamOptions) {
    this.destoryDefer = createDeferrable()
    this.abortController = new AbortController()
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
    this.sub = new TurbostreamSubscription({
      service: opts.service ?? 'wss://api.graze.social',
      method: 'app/api/v1/turbostream/turbostream',
      maxReconnectSeconds: opts.maxReconnectSeconds,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      headers: opts.headers,
      signal: this.abortController.signal,
      onInfo: opts.onInfo,
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
      if ((err as any)?.name === 'AbortError') {
        this.destoryDefer.resolve()
        return
      }
      this.opts.onError(new TurbostreamSubscriptionError(err))
      await wait(this.opts.subscriptionReconnectDelay ?? 3000)
      return this.start()
    }
  }

  private async parseEvt(evt: TurbostreamEventKind): Promise<TurbostreamCommitEvt[]> {
    try {
      if (evt.message.kind === 'commit') {
        return await parseTurbostreamEventKindUnauthenticated(evt, this.matchDid)
      } else {
        return []
      }
    } catch (err) {
      this.opts.onError(new TurbostreamParseError(err, evt))
      return []
    }
  }

  private async processEvt(evt: TurbostreamEventKind) {
    const parsed = await this.parseEvt(evt)
    for (const write of parsed) {
      try {
        await this.opts.handleEvent(write)
      } catch (err) {
        this.opts.onError(new TurbostreamHandlerError(err, write))
      }
    }
  }

  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.destoryDefer.complete
  }
}

class TurbostreamSubscription<T = unknown> {
  constructor(
    public opts: {
      service: string
      method: string
      maxReconnectSeconds?: number
      heartbeatIntervalMs?: number
      /** Applied to the connection's upgrade request (Node.js only). */
      headers?: HeadersInit
      signal?: AbortSignal
      onInfo: (info: string) => void
      validate: (obj: unknown) => T | undefined
      onReconnectError?: (
        error: unknown,
        n: number,
        initialSetup: boolean,
      ) => void
    },
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    const ws = websocket(
      async () => {
        const url = `${this.opts.service}/${this.opts.method}`
        this.opts.onInfo(`Turbostream: ${url}`)
        return url
      },
      {
        // Subscription frames are CBOR.
        dataMode: 'text',
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
      const record = JSON.parse(Buffer.from(chunk).toString())
      yield record
    }
  }
}

const parseTurbostreamEventKindUnauthenticated = async (
  evt: TurbostreamEventKind,
  matchDid: ((did: string) => boolean) | null,
): Promise<TurbostreamCommitEvt[]> => {
  if (!matchDid || matchDid(evt.did)) {
    return await formatTurbostreamCommitEvt(evt)
  }
  return []
}

const formatTurbostreamCommitEvt = async (evt: TurbostreamEventKind): Promise<TurbostreamCommitEvt[]> => {
  const meta: TurbostreamCommitMeta = {
    time_us: evt.message.time_us,
    cursor: evt.message.cursor,
    seq: evt.message.time_us,
    time: new Date(evt.message.time_us/(10**3)).toISOString(),
    rev: evt.message.commit.rev,
    uri: AtUri.make(evt.did, `${evt.message.commit.collection}/${evt.message.commit.rkey}`),
    did: evt.did,
    collection: evt.message.commit.collection,
    rkey: evt.message.commit.rkey,
    hydrated_metadata: evt.hydrated_metadata,
  }

  if (evt.message.commit.operation === 'create' || evt.message.commit.operation === 'update') {
    const cid = parseCid(evt.message.commit.cid)
    const record = jsonToLex(evt.message.commit.record)
    if (!check.is(record, schema.map)) {
      throw new Error('lexicon records be a json object')
    }
    return [{
      ...meta,
      event: evt.message.commit.operation as 'create' | 'update',
      cid,
      record,
    }]
  }

  if (evt.message.commit.operation === 'delete') {
    return [{
      ...meta,
      event: 'delete',
    }]
  }

  return []
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
