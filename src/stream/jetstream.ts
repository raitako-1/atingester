import { createDeferrable, type Deferrable, wait } from '@atproto/common'
import { parseCid } from '@atproto/lex'
import type { FirehoseOptions } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import { type HeadersInit, websocket } from '@atproto/ws-client'
import { type Kind } from '@bsky/jetstream'
import {
  parseAccount,
  parseIdentity,
  parseSync,
} from './firehose.js'
import { network } from '../lexicons/index.js'
import type {
  JetstreamCommitEvt,
  JetstreamCommitMeta,
  JetstreamEvent,
} from '../types.js'
//import { encodeQueryParams } from './util.js'

export type JetstreamOptions = Omit<FirehoseOptions,
  | 'handleEvent'
  | 'unauthenticatedCommits'
> & {
  compress?: boolean
  filterDids?: string[]
  handleEvent: (evt: JetstreamEvent) => void | Promise<void>
  onInfo: (info: string) => void
}

export class Jetstream {
  private sub: JetstreamSubscription<network.bsky.jetstream.subscribeEvents.$Message>
  private abortController: AbortController
  private destoryDefer: Deferrable
  private matchCollection: ((col: string) => boolean) | null = null
  private matchDid: ((did: string) => boolean) | null = null

  constructor(public opts: JetstreamOptions) {
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
    const kinds: Kind[] = []
    if (!opts.excludeAccount) kinds.push('account')
    if (!opts.excludeIdentity) kinds.push('identity')
    if (!opts.excludeCommit) kinds.push('commit')
    if (!opts.excludeSync) kinds.push('sync')
    // Listed explicitly rather than spread: the old `ClientOptions &` shape let
    // arbitrary `ws` options through, which Subscription no longer accepts — a
    // spread would silently drop them.
    this.sub = new JetstreamSubscription({
      service: opts.service ?? 'wss://jetstream.us-west.bsky.network',
      method: network.bsky.jetstream.subscribeEvents.$lxm,
      maxReconnectSeconds: opts.maxReconnectSeconds,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      headers: opts.headers,
      signal: this.abortController.signal,
      compress: opts.compress,
      filterCollections: opts.filterCollections,
      filterDids: opts.filterDids,
      kinds,
      onInfo: opts.onInfo,
      onError: opts.onError,
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
        const result = network.bsky.jetstream.subscribeEvents.$message.safeParse(value)
        if (result.success) {
          return result.value
        } else {
          this.opts.onError(new JetstreamValidationError(result.reason, value))
        }
      },
    })
  }

  async start(): Promise<void> {
    try {
      for await (const evt of this.sub) {
        if (this.opts.runner) {
          const parsed = didAndSeqForEvt(evt)
          if (!parsed) {
            continue
          }
          this.opts.runner.trackEvent(parsed.did, parsed.seq, async () => {
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
      this.opts.onError(new JetstreamSubscriptionError(err))
      await wait(this.opts.subscriptionReconnectDelay ?? 3000)
      return this.start()
    }
  }

  private async parseEvt(
    evt: network.bsky.jetstream.subscribeEvents.$Message,
  ): Promise<JetstreamEvent[]> {
    try {
      if (network.bsky.jetstream.subscribeEvents.commit.$isTypeOf(evt)) {
        if (this.opts.excludeCommit) return []

        return await parseJetstreamKindCommitUnauthenticated(evt, this.matchCollection, this.matchDid)
      } else if (network.bsky.jetstream.subscribeEvents.account.$isTypeOf(evt)) {
        if (this.opts.excludeAccount) return []

        const parsed = parseAccount(evt.account, this.matchDid)
        return parsed ? [{...parsed, cursor: evt.seq, timeUs: evt.time}] : []
      } else if (network.bsky.jetstream.subscribeEvents.identity.$isTypeOf(evt)) {
        if (this.opts.excludeIdentity) return []

        const parsed = await parseIdentity(
          this.opts.idResolver,
          evt.identity,
          this.matchDid,
          this.opts.unauthenticatedHandles,
        )
        return parsed ? [{...parsed, cursor: evt.seq, timeUs: evt.time}] : []
      } else if (network.bsky.jetstream.subscribeEvents.sync.$isTypeOf(evt)) {
        if (this.opts.excludeSync) return []

        const parsed = await parseSync(evt.sync, this.matchDid)
        return parsed ? [{...parsed, cursor: evt.seq, timeUs: evt.time}] : []
      } else {
        return []
      }
    } catch (err) {
      this.opts.onError(new JetstreamParseError(err, evt))
      return []
    }
  }

  private async processEvt(evt: network.bsky.jetstream.subscribeEvents.$Message) {
    const parsed = await this.parseEvt(evt)
    for (const write of parsed) {
      try {
        await this.opts.handleEvent(write)
      } catch (err) {
        this.opts.onError(new JetstreamHandlerError(err, write))
      }
    }
  }

  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.destoryDefer.complete
  }
}

class JetstreamSubscription<T = unknown> {
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
      filterCollections?: string[]
      filterDids?: string[]
      kinds?: Kind[]
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
    // lastSeq is the highest DELIVERED seq = reconnect cursor + dedup floor.
    // undefined means nothing delivered yet (seq 0 passes). A v2 timestamp
    // cursor stays wire-only: leave lastSeq unset so the first delivered event
    // establishes a real floor, while getUrl keeps sending the timestamp.
    /*const isTimestampDomainFloor =
      this.opts.dedupFloor !== undefined &&
      this.opts.dedupFloor >= V2_CURSOR_SEQ_MAX_THRESHOLD
    let lastSeq: number | undefined = isTimestampDomainFloor
      ? undefined
      : this.opts.dedupFloor*/
    const ws = websocket(
      (): string => {
        const u = new URL(`/xrpc/${this.opts.method}`, this.opts.service)
        // Resume from highest-delivered once anything has been delivered; otherwise
        // fall back to the initial wire cursor (which may be 0 = replay from start).
        //const wire = lastSeq ?? this.opts.cursor
        //if (wire !== undefined) u.searchParams.set('cursor', String(wire))
        // The param names are version-gated and must not cross: v2 answers the v1
        // names with a 400 rather than ignoring them.
        for (const c of this.opts.filterCollections ?? [])
          u.searchParams.append('collections', c)
        for (const d of this.opts.filterDids ?? []) u.searchParams.append('dids', d)
        for (const k of this.opts.kinds ?? []) u.searchParams.append('kinds', k)
        const url = u.toString()
        this.opts.onInfo(`Jetstream v2: ${url}`)
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
      const record = JSON.parse(chunk)
      if (record.$type === 'error') {
        this.opts.onError(new JetstreamConverterError(record.error))
        continue
      }
      const result = this.opts.validate(record.payload)
      if (result !== undefined) {
        yield result
      }
    }
  }
}

const didAndSeqForEvt = (
  evt: network.bsky.jetstream.subscribeEvents.$Message,
): { did: string; seq: number } | undefined => {
  if (
    network.bsky.jetstream.subscribeEvents.commit.$isTypeOf(evt) ||
    network.bsky.jetstream.subscribeEvents.account.$isTypeOf(evt) ||
    network.bsky.jetstream.subscribeEvents.identity.$isTypeOf(evt) ||
    network.bsky.jetstream.subscribeEvents.sync.$isTypeOf(evt)
  ) {
    return { seq: evt.seq, did: evt.did }
  }
  return undefined
}

const parseJetstreamKindCommitUnauthenticated = async (
  evt: network.bsky.jetstream.subscribeEvents.Commit,
  matchCollection: ((col: string) => boolean) | null,
  matchDid: ((did: string) => boolean) | null,
): Promise<JetstreamCommitEvt[]> => {
  if (!matchCollection) matchCollection = () => true
  if (!matchDid) matchDid = () => true
  if (matchCollection(evt.collection) && matchDid(evt.did)) {
    return await formatJetstreamCommitEvts(evt)
  }
  return []
}

const formatJetstreamCommitEvts = async (evt: network.bsky.jetstream.subscribeEvents.Commit): Promise<JetstreamCommitEvt[]> => {
  const meta: JetstreamCommitMeta = {
    cursor: evt.seq,
    timeUs: evt.time,
    seq: evt.seq,
    time: evt.time,
    rev: evt.rev,
    uri: AtUri.make(evt.did, `${evt.collection}/${evt.rkey}`),
    did: evt.did,
    collection: evt.collection,
    rkey: evt.rkey,
  }

  if (evt.operation === 'create' || evt.operation === 'update') {
    if (!evt.cid) return []
    const cid = parseCid(evt.cid)
    if (!evt.record) return []
    return [{
      ...meta,
      event: evt.operation as 'create' | 'update',
      cid,
      record: evt.record,
    }]
  }

  if (evt.operation === 'delete') {
    return [{
      ...meta,
      event: 'delete',
    }]
  }

  return []
}

/*function httpScheme(host: string): string {
  const u = new URL(host)
  if (u.protocol === 'ws:') u.protocol = 'http:'
  else if (u.protocol === 'wss:') u.protocol = 'https:'
  return u.origin
}*/

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
    public event: network.bsky.jetstream.subscribeEvents.$Message,
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
