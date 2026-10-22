import { type Deferrable, createDeferrable, wait } from '@atproto/common'
import {
  type DidDocument,
  type IdResolver,
  parseToAtprotoDocument,
} from '@atproto/identity'
import { type Cid, type DidString, isPlainObject } from '@atproto/lex'
import {
  RepoVerificationError,
  cborToLexRecord,
  formatDataKey,
  parseDataKey,
  readCar,
  readCarWithRoot,
  verifyProofs,
} from '@atproto/repo'
import type {
  AccountEvt,
  AccountStatus,
  CommitEvt,
  CommitMeta,
  Event,
  FirehoseOptions as FirehoseOptionsBase,
  IdentityEvt,
  SyncEvt,
} from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import { type HeadersInit, websocket } from '@atproto/ws-client'
import { ensureChunkIsMessage } from '@atproto/xrpc-server'
import { com } from '../lexicons/index.js'
import { encodeQueryParams } from './util.js'

export type FirehoseOptions = FirehoseOptionsBase & {
  filterDids?: string[]
  onInfo: (info: string) => void
}

export class Firehose {
  private sub: Subscription<com.atproto.sync.subscribeRepos.$Message>
  private abortController: AbortController
  private destoryDefer: Deferrable
  private matchCollection: ((col: string) => boolean) | null = null
  private matchDid: ((did: string) => boolean) | null = null

  constructor(public opts: FirehoseOptions) {
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
    this.sub = new Subscription({
      service: opts.service ?? 'wss://bsky.network',
      method: com.atproto.sync.subscribeRepos.$lxm,
      maxReconnectSeconds: opts.maxReconnectSeconds,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      headers: opts.headers,
      signal: this.abortController.signal,
      onInfo: opts.onInfo,
      getParams: async () => {
        let cursor: number | undefined
        if (this.opts.runner) {
          cursor = await this.opts.runner.getCursor()
        } else if (this.opts.getCursor) {
          cursor = await this.opts.getCursor()
        }
        return cursor === undefined ? undefined : { cursor }
      },
      validate: (value: unknown) => {
        const result = com.atproto.sync.subscribeRepos.$message.safeParse(value)
        if (result.success) {
          return result.value
        } else {
          this.opts.onError(new FirehoseValidationError(result.reason, value))
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
      this.opts.onError(new FirehoseSubscriptionError(err))
      await wait(this.opts.subscriptionReconnectDelay ?? 3000)
      return this.start()
    }
  }

  private async parseEvt(
    evt: com.atproto.sync.subscribeRepos.$Message,
  ): Promise<Event[]> {
    try {
      if (com.atproto.sync.subscribeRepos.commit.$isTypeOf(evt)) {
        if (this.opts.excludeCommit) return []

        return this.opts.unauthenticatedCommits
          ? await parseCommitUnauthenticated(evt, this.matchCollection, this.matchDid)
          : await parseCommitAuthenticated(
              this.opts.idResolver,
              evt,
              this.matchCollection,
              this.matchDid,
            )
      } else if (com.atproto.sync.subscribeRepos.account.$isTypeOf(evt)) {
        if (this.opts.excludeAccount) return []

        const parsed = parseAccount(evt, this.matchDid)
        return parsed ? [parsed] : []
      } else if (com.atproto.sync.subscribeRepos.identity.$isTypeOf(evt)) {
        if (this.opts.excludeIdentity) return []

        const parsed = await parseIdentity(
          this.opts.idResolver,
          evt,
          this.matchDid,
          this.opts.unauthenticatedHandles,
        )
        return parsed ? [parsed] : []
      } else if (com.atproto.sync.subscribeRepos.sync.$isTypeOf(evt)) {
        if (this.opts.excludeSync) return []

        const parsed = await parseSync(evt, this.matchDid)
        return parsed ? [parsed] : []
      } else {
        return []
      }
    } catch (err) {
      this.opts.onError(new FirehoseParseError(err, evt))
      return []
    }
  }

  private async processEvt(evt: com.atproto.sync.subscribeRepos.$Message) {
    const parsed = await this.parseEvt(evt)
    for (const write of parsed) {
      try {
        await this.opts.handleEvent(write)
      } catch (err) {
        this.opts.onError(new FirehoseHandlerError(err, write))
      }
    }
  }

  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.destoryDefer.complete
  }
}

class Subscription<T = unknown> {
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
      getParams?: () =>
        | Record<string, unknown>
        | Promise<Record<string, unknown> | undefined>
        | undefined
    },
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    const ws = websocket(
      async () => {
        const params = (await this.opts.getParams?.()) ?? {}
        const query = encodeQueryParams(params)
        const url = `${this.opts.service}/xrpc/${this.opts.method}?${query}`
        this.opts.onInfo(`Firehose: ${url}`)
        return url
      },
      {
        // Subscription frames are CBOR.
        dataMode: 'binary',
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
      const message = ensureChunkIsMessage(chunk)
      const t = message.header.t

      const typedBody = isPlainObject(message.body)
        ? t !== undefined
          ? {
              ...message.body,
              $type: t.startsWith('#') ? this.opts.method + t : t,
            }
          : message.body
        : undefined

      const result = this.opts.validate(typedBody)
      if (result !== undefined) {
        yield result
      }
    }
  }
}

const didAndSeqForEvt = (
  evt: com.atproto.sync.subscribeRepos.$Message,
): { did: string; seq: number } | undefined => {
  if (com.atproto.sync.subscribeRepos.commit.$isTypeOf(evt)) {
    return { seq: evt.seq, did: evt.repo }
  } else if (
    com.atproto.sync.subscribeRepos.account.$isTypeOf(evt) ||
    com.atproto.sync.subscribeRepos.identity.$isTypeOf(evt) ||
    com.atproto.sync.subscribeRepos.sync.$isTypeOf(evt)
  ) {
    return { seq: evt.seq, did: evt.did }
  }
  return undefined
}

const parseCommitAuthenticated = async (
  idResolver: IdResolver,
  evt: com.atproto.sync.subscribeRepos.Commit,
  matchCollection: ((col: string) => boolean) | null,
  matchDid: ((did: string) => boolean) | null,
  forceKeyRefresh = false,
): Promise<CommitEvt[]> => {
  const did = evt.repo
  const ops = maybeFilterOps(did, evt.ops, matchCollection, matchDid)
  if (ops.length === 0) {
    return []
  }
  const claims = ops.map((op) => {
    const { collection, rkey } = parseDataKey(op.path)
    return {
      collection,
      rkey,
      cid: op.action === 'delete' ? null : op.cid,
    }
  })
  const key = await idResolver.did.resolveAtprotoKey(did, forceKeyRefresh)
  const verifiedCids: Record<string, Cid | null> = {}
  try {
    const results = await verifyProofs(evt.blocks, claims, did, key)
    results.verified.forEach((op) => {
      const path = formatDataKey(op.collection, op.rkey)
      verifiedCids[path] = op.cid
    })
  } catch (err) {
    if (err instanceof RepoVerificationError && !forceKeyRefresh) {
      return parseCommitAuthenticated(idResolver, evt, matchCollection, matchDid, true)
    }
    throw err
  }
  const verifiedOps: com.atproto.sync.subscribeRepos.RepoOp[] = ops.filter(
    (op) => {
      const verifiedCid = verifiedCids[op.path]
      if (op.action === 'delete') {
        return verifiedCid === null
      } else {
        return (
          op.cid != null && verifiedCid != null && verifiedCid.equals(op.cid)
        )
      }
    },
  )
  return formatCommitOps(evt, verifiedOps, {
    skipCidVerification: true, // already checked via verifyProofs()
  })
}

const parseCommitUnauthenticated = async (
  evt: com.atproto.sync.subscribeRepos.Commit,
  matchCollection: ((col: string) => boolean) | null,
  matchDid: ((did: string) => boolean) | null,
): Promise<CommitEvt[]> => {
  const ops = maybeFilterOps(evt.repo, evt.ops, matchCollection, matchDid)
  return formatCommitOps(evt, ops)
}

const maybeFilterOps = (
  did: DidString,
  ops: com.atproto.sync.subscribeRepos.RepoOp[],
  matchCollection: ((col: string) => boolean) | null,
  matchDid: ((did: string) => boolean) | null,
): com.atproto.sync.subscribeRepos.RepoOp[] => {
  if (!matchCollection) matchCollection = () => true
  if (!matchDid) matchDid = () => true
  return ops.filter((op) => {
    const { collection } = parseDataKey(op.path)
    return matchCollection(collection) && matchDid(did)
  })
}

const formatCommitOps = async (
  evt: com.atproto.sync.subscribeRepos.Commit,
  ops: com.atproto.sync.subscribeRepos.RepoOp[],
  options?: { skipCidVerification: boolean },
) => {
  const car = await readCar(evt.blocks, options)

  const evts: CommitEvt[] = []

  for (const op of ops) {
    const uri = AtUri.make(evt.repo, op.path)

    const meta: CommitMeta = {
      seq: evt.seq,
      time: evt.time,
      commit: evt.commit,
      blocks: car.blocks,
      rev: evt.rev,
      uri,
      did: uri.did,
      collection: uri.collection,
      rkey: uri.rkey,
    }

    if (op.action === 'create' || op.action === 'update') {
      if (!op.cid) continue
      const recordBytes = car.blocks.get(op.cid)
      if (!recordBytes) continue
      const record = cborToLexRecord(recordBytes)
      evts.push({
        ...meta,
        event: op.action as 'create' | 'update',
        cid: op.cid,
        record,
      })
    }

    if (op.action === 'delete') {
      evts.push({
        ...meta,
        event: 'delete',
      })
    }
  }

  return evts
}

export const parseSync = async (
  evt: com.atproto.sync.subscribeRepos.Sync,
  matchDid: ((did: string) => boolean) | null,
): Promise<SyncEvt | null> => {
  if (matchDid && !matchDid(evt.did)) return null
  const car = await readCarWithRoot(evt.blocks)

  return {
    event: 'sync',
    seq: evt.seq,
    time: evt.time,
    did: evt.did,
    cid: car.root,
    rev: evt.rev,
    blocks: car.blocks,
  }
}

export const parseIdentity = async (
  idResolver: IdResolver,
  evt: com.atproto.sync.subscribeRepos.Identity,
  matchDid: ((did: string) => boolean) | null,
  unauthenticated = false,
): Promise<IdentityEvt | null> => {
  if (matchDid && !matchDid(evt.did)) return null
  const res = await idResolver.did.resolve(evt.did)
  const handle =
    res && !unauthenticated
      ? await verifyHandle(idResolver, evt.did, res)
      : undefined

  return {
    event: 'identity',
    seq: evt.seq,
    time: evt.time,
    did: evt.did,
    handle,
    didDocument: res ?? undefined,
  }
}

const verifyHandle = async (
  idResolver: IdResolver,
  did: string,
  didDoc: DidDocument,
): Promise<string | undefined> => {
  const { handle } = parseToAtprotoDocument(didDoc)
  if (!handle) {
    return undefined
  }
  const res = await idResolver.handle.resolve(handle)
  return res === did ? handle : undefined
}

export const parseAccount = (
  evt: com.atproto.sync.subscribeRepos.Account,
  matchDid: ((did: string) => boolean) | null,
): AccountEvt | undefined => {
  if (matchDid && !matchDid(evt.did)) return undefined
  if (evt.status && !isValidStatus(evt.status)) return
  return {
    event: 'account',
    seq: evt.seq,
    time: evt.time,
    did: evt.did,
    active: evt.active,
    status: evt.status as AccountStatus | undefined,
  }
}

const isValidStatus = (str: string): str is AccountStatus => {
  return ['takendown', 'suspended', 'deleted', 'deactivated'].includes(str)
}

export class FirehoseValidationError extends Error {
  constructor(
    err: unknown,
    public value: unknown,
  ) {
    super('error in firehose event lexicon validation', { cause: err })
  }
}

export class FirehoseParseError extends Error {
  constructor(
    err: unknown,
    public event: com.atproto.sync.subscribeRepos.$Message,
  ) {
    super('error in parsing and authenticating firehose event', { cause: err })
  }
}

export class FirehoseSubscriptionError extends Error {
  constructor(err: unknown) {
    super('error on firehose subscription', { cause: err })
  }
}

export class FirehoseHandlerError extends Error {
  constructor(
    err: unknown,
    public event: Event,
  ) {
    super('error in firehose event handler', { cause: err })
  }
}
