import { createDeferrable, type Deferrable, wait } from '@atproto/common'
import {
  type DidDocument,
  IdResolver,
  parseToAtprotoDocument,
} from '@atproto/identity'
import {
  cborToLexRecord,
  formatDataKey,
  parseDataKey,
  readCar,
  readCarWithRoot,
  RepoVerificationError,
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
import {
  ensureChunkIsMessage,
  WebSocketKeepAlive,
} from '@atproto/xrpc-server'
import { CID } from 'multiformats/cid'
import { type ClientOptions } from 'ws'
import { ids, lexicons } from '../lexicon/lexicons'
import {
  type Account,
  type Commit,
  type Identity,
  type OutputSchema as RepoEvent,
  type RepoOp,
  type Sync,
  isAccount,
  isCommit,
  isIdentity,
  isSync,
} from '../lexicon/types/com/atproto/sync/subscribeRepos'

export type FirehoseOptions = FirehoseOptionsBase & {
  filterDids?: string[]
  onInfo: (info: string) => void
}

export class Firehose {
  private sub: FirehoseSubscription<RepoEvent>
  private abortController: AbortController
  private destoryDefer: Deferrable

  constructor(public opts: FirehoseOptions) {
    this.destoryDefer = createDeferrable()
    this.abortController = new AbortController()
    if (this.opts.getCursor && this.opts.runner) {
      throw new Error('Must set only `getCursor` or `runner`')
    }
    this.sub = new FirehoseSubscription({
      ...opts,
      service: opts.service ?? 'wss://bsky.network',
      method: 'com.atproto.sync.subscribeRepos',
      signal: this.abortController.signal,
      getParams: async () => {
        const getCursorFn = this.opts.runner?.getCursor ?? this.opts.getCursor
        if (!getCursorFn) {
          return undefined
        }
        const cursor = await getCursorFn()
        return { cursor }
      },
      validate: (value: unknown) => {
        try {
          return lexicons.assertValidXrpcMessage<RepoEvent>(
            ids.ComAtprotoSyncSubscribeRepos,
            value,
          )
        } catch (err) {
          this.opts.onError(new FirehoseValidationError(err, value))
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
      if (err && err['name'] === 'AbortError') {
        this.destoryDefer.resolve()
        return
      }
      this.opts.onError(new FirehoseSubscriptionError(err))
      await wait(this.opts.subscriptionReconnectDelay ?? 3000)
      return this.start()
    }
  }

  private async parseEvt(evt: RepoEvent): Promise<Event[]> {
    try {
      if (isCommit(evt) && !this.opts.excludeCommit) {
        return this.opts.unauthenticatedCommits
          ? await parseCommitUnauthenticated(evt, this.opts.filterCollections ?? [], this.opts.filterDids ?? [])
          : await parseCommitAuthenticated(
              this.opts.idResolver,
              evt,
              this.opts.filterCollections ?? [],
              this.opts.filterDids ?? [],
            )
      } else if (isAccount(evt) && !this.opts.excludeAccount) {
        const parsed = parseAccount(evt)
        return parsed ? [parsed] : []
      } else if (isIdentity(evt) && !this.opts.excludeIdentity) {
        const parsed = await parseIdentity(
          this.opts.idResolver,
          evt,
          this.opts.unauthenticatedHandles,
        )
        return parsed ? [parsed] : []
      } else if (isSync(evt) && !this.opts.excludeSync) {
        const parsed = await parseSync(evt)
        return parsed ? [parsed] : []
      } else {
        return []
      }
    } catch (err) {
      this.opts.onError(new FirehoseParseError(err, evt))
      return []
    }
  }

  private async processEvt(evt: RepoEvent) {
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

export class FirehoseSubscription<T = unknown> {
  constructor(
    public opts: ClientOptions & {
      service: string
      method: string
      maxReconnectSeconds?: number
      heartbeatIntervalMs?: number
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

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    const ws = new WebSocketKeepAlive({
      ...this.opts,
      getUrl: async () => {
        const params = (await this.opts.getParams?.()) ?? {}
        const query = encodeQueryParams(params)
        const url = `${this.opts.service}/xrpc/${this.opts.method}?${query}`
        this.opts.onInfo(`Firehose: ${url}`)
        return url
      },
    })
    for await (const chunk of ws) {
      const message = await ensureChunkIsMessage(chunk)
      const t = message.header.t
      const clone = message.body !== undefined ? { ...message.body } : undefined
      if (clone !== undefined && t !== undefined) {
        clone['$type'] = t.startsWith('#') ? this.opts.method + t : t
      }
      const result = this.opts.validate(clone)
      if (result !== undefined) {
        yield result
      }
    }
  }
}

const didAndSeqForEvt = (
  evt: RepoEvent,
): { did: string; seq: number } | undefined => {
  if (isCommit(evt)) return { seq: evt.seq, did: evt.repo }
  else if (isAccount(evt) || isIdentity(evt) || isSync(evt))
    return { seq: evt.seq, did: evt.did }
  return undefined
}

function encodeQueryParams(obj: Record<string, unknown>): string {
  const params = new URLSearchParams()
  Object.entries(obj).forEach(([key, value]) => {
    const encoded = encodeQueryParam(value)
    if (Array.isArray(encoded)) {
      encoded.forEach((enc) => params.append(key, enc))
    } else {
      params.set(key, encoded)
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


export const parseCommitAuthenticated = async (
  idResolver: IdResolver,
  evt: Commit,
  filterCollections: string[],
  filterDids: string[],
  forceKeyRefresh = false,
): Promise<CommitEvt[]> => {
  const did = evt.repo
  const ops = maybeFilterOps(evt, filterCollections, filterDids)
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
  const verifiedCids: Record<string, CID | null> = {}
  try {
    const results = await verifyProofs(evt.blocks, claims, did, key)
    results.verified.forEach((op) => {
      const path = formatDataKey(op.collection, op.rkey)
      verifiedCids[path] = op.cid
    })
  } catch (err) {
    if (err instanceof RepoVerificationError && !forceKeyRefresh) {
      return parseCommitAuthenticated(idResolver, evt, filterCollections, filterDids, true)
    }
    throw err
  }
  const verifiedOps: RepoOp[] = ops.filter((op) => {
    if (op.action === 'delete') {
      return verifiedCids[op.path] === null
    } else {
      return op.cid !== null && op.cid.equals(verifiedCids[op.path])
    }
  })
  return formatCommitOps(evt, verifiedOps)
}

export const parseCommitUnauthenticated = async (
  evt: Commit,
  filterCollections: string[],
  filterDids: string[],
): Promise<CommitEvt[]> => {
  const ops = maybeFilterOps(evt, filterCollections, filterDids)
  return formatCommitOps(evt, ops)
}

const maybeFilterOps = (
  evt: Commit,
  filterCollections: string[],
  filterDids: string[],
): RepoOp[] => {
  if (!filterCollections) return evt.ops
  return evt.ops.filter((op) => {
    const { collection } = parseDataKey(op.path)
    return (filterCollections.length === 0 || filterCollections.includes(collection)) && (filterDids.length === 0 || filterDids.includes(evt.repo))
  })
}

const formatCommitOps = async (evt: Commit, ops: RepoOp[]) => {
  const car = await readCar(evt.blocks)

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
      did: uri.host,
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

export const parseSync = async (evt: Sync): Promise<SyncEvt | null> => {
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
  evt: Identity,
  unauthenticated = false,
): Promise<IdentityEvt | null> => {
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

export const parseAccount = (evt: Account): AccountEvt | undefined => {
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
    public event: RepoEvent,
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
