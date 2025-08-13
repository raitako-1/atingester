import type { JsonValue } from '@atproto/common-web'
import type { JsonBlobRef, RepoRecord } from "@atproto/lexicon"
import type { AccountEvt, CommitMeta, Event, IdentityEvt } from '@atproto/sync'
import { CID } from 'multiformats/cid'
import type { Account, Identity } from './lexicon/types/com/atproto/sync/subscribeRepos'

export type IngesterEvent = Event | JetstreamEvent

export type JetstreamEvent = JetstreamCommitEvt | JetstreamIdentityEvt | JetstreamAccountEvt

export type JetstreamCommitEvt = JetstreamCreate | JetstreamUpdate | JetstreamDelete

export type JetstreamCommitMeta = Omit<CommitMeta, 'seq' | 'commit' | 'blocks'> & {
  time_us: number
}

export type JetstreamCreate = JetstreamCommitMeta & {
  event: 'create'
  record: RepoRecord
  cid: CID
}

export type JetstreamUpdate = JetstreamCommitMeta & {
  event: 'update'
  record: RepoRecord
  cid: CID
}

export type JetstreamDelete = JetstreamCommitMeta & {
  event: 'delete'
}

export type JetstreamIdentityEvt = IdentityEvt & {
  time_us: number
}

export type JetstreamAccountEvt = AccountEvt & {
  time_us: number
}

export type JetstreamValue =
  | JsonValue
  | JsonBlobRef
  | Array<JetstreamValue>
  | { [key: string]: JetstreamValue }

export type JetstreamRecord = Record<string, JetstreamValue>

export type JetstreamEventKind = JetstreamEventKindAccount | JetstreamEventKindCommit | JetstreamEventKindIdentity

export type JetstreamEventKindAccount = {
  did: string
  time_us: number
  kind: 'account'
  account: Account
}

export type JetstreamEventKindCommit = {
  did: string
  time_us: number
  kind: 'commit'
  commit: JetstreamEventKindCommitOperationCreate | JetstreamEventKindCommitOperationUpdate | JetstreamEventKindCommitOperationDelete
}

export type JetstreamEventKindCommitOperationCreate = {
  rev: string
  operation: 'create'
  collection: string
  rkey: string
  record: JetstreamRecord
  cid: string
}

export type JetstreamEventKindCommitOperationUpdate = {
  rev: string
  operation: 'update'
  collection: string
  rkey: string
  record: JetstreamRecord
  cid: string
}

export type JetstreamEventKindCommitOperationDelete = {
  rev: string
  operation: 'delete'
  collection: string
  rkey: string
}

export type JetstreamEventKindIdentity = {
  did: string
  time_us: number
  kind: 'identity'
  identity: Identity
}
