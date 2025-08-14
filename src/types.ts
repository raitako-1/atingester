import type { JsonValue } from '@atproto/common-web'
import type { JsonBlobRef, RepoRecord } from "@atproto/lexicon"
import type { AccountEvt, CommitMeta, Event, IdentityEvt } from '@atproto/sync'
import { CID } from 'multiformats/cid'
import { StatusView } from './lexicon/types/app/bsky/actor/defs'
import type { Account, Identity } from './lexicon/types/com/atproto/sync/subscribeRepos'

export type IngesterEvent = Event | JetstreamEvent | TurbostreamCommitEvt


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


export type TurbostreamCommitEvt = TurbostreamCreate | TurbostreamUpdate | TurbostreamDelete

export type TurbostreamCommitMeta = Omit<CommitMeta, 'seq' | 'commit' | 'blocks'> & {
  time_us: number
  hydrated_metadata: TurbostreamEventKindHydratedMetadata
}

export type TurbostreamCreate = TurbostreamCommitMeta & {
  event: 'create'
  record: RepoRecord
  cid: CID
}

export type TurbostreamUpdate = TurbostreamCommitMeta & {
  event: 'update'
  record: RepoRecord
  cid: CID
}

export type TurbostreamDelete = TurbostreamCommitMeta & {
  event: 'delete'
}


export type JetstreamValue =
  | JsonValue
  | Uint8Array
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


export type TurbostreamEventKind = {
  at_uri: string
  did: string
  time_us: number | null
  message: JetstreamEventKindCommit
  hydrated_metadata: TurbostreamEventKindHydratedMetadata
}

export type TurbostreamEventKindHydratedMetadata = {
  user: TurbostreamEventKindHydratedMetadataUserDetailed | null
  mentions: Record<string, TurbostreamEventKindHydratedMetadataUserDetailed>
  parent_post: TurbostreamEventKindHydratedMetadataPost | null
  reply_post: TurbostreamEventKindHydratedMetadataPost | null
  quote_post: TurbostreamEventKindHydratedMetadataPost | null
}

export type TurbostreamEventKindHydratedMetadataActorViewerState = {
  blocked_by: boolean | null
  blocking: string | null
  blocking_by_list: TurbostreamEventKindHydratedMetadataList | null
  followed_by: string | null
  following: string | null
  known_followers: {
    count: number
    followers: TurbostreamEventKindHydratedMetadataUserBasic[]
    py_type: 'app.bsky.actor.defs#knownFollowers'
  } | null
  muted: boolean
  muted_by_list: TurbostreamEventKindHydratedMetadataList | null
  py_type: 'app.bsky.actor.defs#viewerState'
}

export type TurbostreamEventKindHydratedMetadataAspectRatio = {
  width: number
  height: number
  py_type: 'app.bsky.embed.defs#aspectRatio'
}

export type TurbostreamEventKindHydratedMetadataBlobRef = {
  mime_type: string
  size: number
  ref: {
    link: string
  }
  py_type: 'blob'
}

export type TurbostreamEventKindHydratedMetadataEmbedImagesView = {
  images: {
    thumb: string
    fullsize: string
    alt: string
    aspect_ratio: TurbostreamEventKindHydratedMetadataAspectRatio | null
    py_type: 'app.bsky.embed.images#viewImage'
  }[]
  py_type: 'app.bsky.embed.images#view'
}

export type TurbostreamEventKindHydratedMetadataEmbedVideoView = {
  cid: string
  playlist: string
  thumbnail: string | null
  alt: string | null
  aspect_ratio: TurbostreamEventKindHydratedMetadataAspectRatio | null
  py_type: 'app.bsky.embed.video#view'
}

export type TurbostreamEventKindHydratedMetadataEmbedExternalView = {
  external: {
    uri: string
    title: string
    description: string
    thumb: string | null
    py_type: 'app.bsky.embed.external#viewExternal'
  }
  py_type: 'app.bsky.embed.external#view'
}

export type TurbostreamEventKindHydratedMetadataEmbedRecordView = {
  record:
    | {
      author: TurbostreamEventKindHydratedMetadataUserBasic
      cid: string
      indexed_at: string
      uri: string
      value: TurbostreamEventKindHydratedMetadataPostRecord
      embeds: TurbostreamEventKindHydratedMetadataEmbedView[] | null
      labels: TurbostreamEventKindHydratedMetadataLabel[] | null
      like_count: number | null
      quote_count: number | null
      reply_count: number | null
      repost_count: number | null
      py_type: 'app.bsky.embed.record#viewRecord'
    }
    | {
      uri: string
      notFound: true
      py_type: 'app.bsky.embed.record#viewNotFound'
    }
    | {
      uri: string
      blocked: true
      author: {
        did: string
        viewer: TurbostreamEventKindHydratedMetadataActorViewerState | null
        py_type: 'app.bsky.feed.defs#blockedAuthor'
      }
      py_type: 'app.bsky.embed.record#viewBlocked'
    }
    | {
      uri: string
      detached: true
      py_type: 'app.bsky.embed.record#viewDetached'
    }
    | {
      uri: string
      cid: string
      did: string
      creator: TurbostreamEventKindHydratedMetadataUser
      displayName: string
      description: string | null
      descriptionFacets: TurbostreamEventKindHydratedMetadataFacet[] | null
      avatar: string | null
      likeCount: number | null
      acceptsInteractions: boolean | null
      labels: TurbostreamEventKindHydratedMetadataLabel[] | null
      viewer: {
        like: string | null
        py_type: 'app.bsky.feed.defs#generatorViewerState'
      } | null
      contentMode:
        | 'app.bsky.feed.defs#contentModeUnspecified'
        | 'app.bsky.feed.defs#contentModeVideo'
        | (string & {})
        | null
      indexedAt: string
      py_type: 'app.bsky.feed.defs#generatorView'
    }
    | {
      uri: string
      cid: string
      creator: TurbostreamEventKindHydratedMetadataUser
      name: string
      purpose:
        | 'app.bsky.graph.defs#modlist'
        | 'app.bsky.graph.defs#curatelist'
        | 'app.bsky.graph.defs#referencelist'
        | (string & {})
      description: string | null
      descriptionFacets: TurbostreamEventKindHydratedMetadataFacet[] | null
      avatar: string | null
      listItemCount: number | null
      labels: TurbostreamEventKindHydratedMetadataLabel[] | null
      viewer: TurbostreamEventKindHydratedMetadataGraphListViewerState | null
      indexedAt: string
      py_type: 'app.bsky.graph.defs#listView'
    }
    | {
      uri: string
      cid: string
      creator: TurbostreamEventKindHydratedMetadataUser
      likeCount: number | null
      viewer: {
        like: string | null
        py_type: 'app.bsky.labeler.defs#labelerViewerState'
      } | null
      indexedAt: string
      labels: TurbostreamEventKindHydratedMetadataLabel[] | null
      py_type: 'app.bsky.labeler.defs#labelerView'
    }
    | TurbostreamEventKindHydratedMetadataStarterPackViewBasic
  py_type: 'app.bsky.embed.record#view'
}

export type TurbostreamEventKindHydratedMetadataEmbedView =
| TurbostreamEventKindHydratedMetadataEmbedImagesView
| TurbostreamEventKindHydratedMetadataEmbedVideoView
| TurbostreamEventKindHydratedMetadataEmbedExternalView
| TurbostreamEventKindHydratedMetadataEmbedRecordView
| {
  record: TurbostreamEventKindHydratedMetadataEmbedRecordView
  media:
    | TurbostreamEventKindHydratedMetadataEmbedImagesView
    | TurbostreamEventKindHydratedMetadataEmbedVideoView
    | TurbostreamEventKindHydratedMetadataEmbedExternalView
  py_type: 'app.bsky.embed.recordWithMedia#view'
}

export type TurbostreamEventKindHydratedMetadataEmbedImages = {
  images: {
    image: TurbostreamEventKindHydratedMetadataBlobRef
    alt: string
    aspectRatio: TurbostreamEventKindHydratedMetadataAspectRatio | null
    py_type: 'app.bsky.embed.images#image'
  }[]
  py_type: 'app.bsky.embed.images'
}

export type TurbostreamEventKindHydratedMetadataEmbedVideo = {
  video: TurbostreamEventKindHydratedMetadataBlobRef
  captions: {
    lang: string
    file: TurbostreamEventKindHydratedMetadataBlobRef
    py_type: 'app.bsky.embed.video#caption'
  }[] | null
  alt: string | null
  aspectRatio: TurbostreamEventKindHydratedMetadataAspectRatio | null
  py_type: 'app.bsky.embed.video'
}

export type TurbostreamEventKindHydratedMetadataEmbedExternal = {
  external: {
    uri: string
    title: string
    description: string
    thumb: TurbostreamEventKindHydratedMetadataBlobRef | null
    py_type: 'app.bsky.embed.external#external'
  }
  py_type: 'app.bsky.embed.external'
}

export type TurbostreamEventKindHydratedMetadataEmbedRecord = {
  record: TurbostreamEventKindHydratedMetadataStrongRef
  py_type: 'app.bsky.embed.record'
}

export type TurbostreamEventKindHydratedMetadataFacet = {
  features: (
    | {
      did: string
      py_type: 'app.bsky.richtext.facet#mention'
    }
    | {
      uri: string
      py_type: 'app.bsky.richtext.facet#link'
    }
    | {
      tag: string
      py_type: 'app.bsky.richtext.facet#tag'
    }
  )[]
  index: {
    byte_end: number
    byte_start: number
    py_type: 'app.bsky.richtext.facet#byteSlice'
  }
  py_type: 'app.bsky.richtext.facet'
}

export type TurbostreamEventKindHydratedMetadataGraphListViewerState = {
  blocked: string | null
  muted: boolean | null
  py_type: 'app.bsky.graph.defs#listViewerState'
}

export type TurbostreamEventKindHydratedMetadataLabel = {
  cts: string
  src: string
  uri: string
  val: string
  cid: string | null
  exp: string | null
  neg: boolean | null
  sig: Uint8Array | null
  ver: number | null
  py_type: 'com.atproto.label.defs#label'
}

export type TurbostreamEventKindHydratedMetadataList = {
  cid: string
  name: string
  purpose: 'app.bsky.graph.defs#modlist' | 'app.bsky.graph.defs#curatelist' | 'app.bsky.graph.defs#referencelist' | (string & {})
  uri: string
  avatar: string | null
  indexed_at: string | null
  labels: TurbostreamEventKindHydratedMetadataLabel[] | null
  list_item_count: number | null
  viewer: TurbostreamEventKindHydratedMetadataGraphListViewerState | null
  py_type: 'app.bsky.graph.defs#listViewBasic'
}

export type TurbostreamEventKindHydratedMetadataPostRecord = {
  created_at: string
  text: string
  embed:
    | TurbostreamEventKindHydratedMetadataEmbedImages
    | TurbostreamEventKindHydratedMetadataEmbedVideo
    | TurbostreamEventKindHydratedMetadataEmbedExternal
    | TurbostreamEventKindHydratedMetadataEmbedRecord
    | {
      record: TurbostreamEventKindHydratedMetadataEmbedRecord
      media:
        | TurbostreamEventKindHydratedMetadataEmbedImages
        | TurbostreamEventKindHydratedMetadataEmbedVideo
        | TurbostreamEventKindHydratedMetadataEmbedExternal
      py_type: 'app.bsky.embed.recordWithMedia'
    }
    | null
  entities: {
    index: {
      start: number
      end: number
      py_type: 'app.bsky.feed.post#textSlice'
    }
    type: string
    value: string
    py_type: 'app.bsky.feed.post#entity'
  }[] | null
  facets: TurbostreamEventKindHydratedMetadataFacet[] | null
  labels: {
    values: {
      val: string
      py_type: 'com.atproto.label.defs#selfLabel'
    }[]
    py_type: 'com.atproto.label.defs#selfLabels'
  } | null
  langs: string[] | null
  reply: {
    root: TurbostreamEventKindHydratedMetadataStrongRef
    parent: TurbostreamEventKindHydratedMetadataStrongRef
    py_type: 'app.bsky.feed.post#replyRef'
  } | null
  tags: string[] | null
  py_type: 'app.bsky.feed.post'
}

export type TurbostreamEventKindHydratedMetadataStarterPackViewBasic = {
  cid: string
  creator: TurbostreamEventKindHydratedMetadataUserBasic
  indexed_at: string
  record: {
    created_at: string
    list: string
    name: string
    description: string | null
    description_facets: TurbostreamEventKindHydratedMetadataFacet[] | null
    feeds: {
      uri: string
      py_type: 'app.bsky.graph.starterpack#feedItem'
    }[] | null
    py_type: 'app.bsky.graph.starterpack'
    [k: string]: unknown
  }
  uri: string
  joined_all_time_count: number | null
  joined_week_count: number | null
  labels: TurbostreamEventKindHydratedMetadataLabel[] | null
  list_item_count: number | null
  py_type: 'app.bsky.graph.defs#starterPackViewBasic'
}

export type TurbostreamEventKindHydratedMetadataStrongRef = {
    uri: string
    cid: string
    py_type: 'com.atproto.repo.strongRef'
  }

export type TurbostreamEventKindHydratedMetadataUserBasic = {
  did: string
  handle: string
  associated: {
    chat: {
      allow_incoming: 'all' | 'none' | 'following' | (string & {})
      py_type: 'app.bsky.actor.defs#profileAssociatedChat'
    } | null
    feedgens: number | null
    labeler: boolean | null
    lists: number | null
    starter_packs: number | null
    py_type: 'app.bsky.actor.defs#profileAssociated'
    activitySubscription: {
      allowSubscriptions: 'followers' | 'mutuals' | 'none' | (string & {})
    } | null
  } | null
  avatar: string | null
  created_at: string | null
  display_name: string | null
  labels: TurbostreamEventKindHydratedMetadataLabel[] | null
  verification: {
    trusted_verifier_status: 'valid' | 'invalid' | 'none' | (string & {})
    verifications: {
      created_at: string
      is_valid: boolean
      issuer: string
      uri: string
      py_type: 'app.bsky.actor.defs#verificationView'
    }[]
    verified_status: 'valid' | 'invalid' | 'none' | (string & {})
    py_type: 'app.bsky.actor.defs#verificationState'
  } | null
  viewer: TurbostreamEventKindHydratedMetadataActorViewerState | null
  status?: StatusView
  py_type: 'app.bsky.actor.defs#profileViewBasic'
}

export type TurbostreamEventKindHydratedMetadataUser = Omit<TurbostreamEventKindHydratedMetadataUserBasic, 'py_type'> & {
  description: string | null
  indexed_at: string | null
  py_type: 'app.bsky.actor.defs#profileView'
}

export type TurbostreamEventKindHydratedMetadataUserDetailed = Omit<TurbostreamEventKindHydratedMetadataUser, 'py_type'> & {
  banner: string | null
  followers_count: number | null
  follows_count: number | null
  joined_via_starter_pack: TurbostreamEventKindHydratedMetadataStarterPackViewBasic | null
  pinned_post: TurbostreamEventKindHydratedMetadataStrongRef | null
  posts_count: number | null
  py_type: 'app.bsky.actor.defs#profileViewDetailed'
}

export type TurbostreamEventKindHydratedMetadataPost = {
  author: TurbostreamEventKindHydratedMetadataUserBasic
  cid: string
  indexed_at: string
  record: TurbostreamEventKindHydratedMetadataPostRecord
  uri: string
  embed: TurbostreamEventKindHydratedMetadataEmbedView | null
  labels: TurbostreamEventKindHydratedMetadataLabel[] | null
  like_count: number | null
  quote_count: number | null
  reply_count: number | null
  repost_count: number | null
  threadgate: {
    cid: string | null
    lists: TurbostreamEventKindHydratedMetadataList[] | null
    record: {
      created_at: string
      post: string
      allow: (
        | {py_type: 'app.bsky.feed.threadgate#mentionRule'}
        | {py_type: 'app.bsky.feed.threadgate#followerRule'}
        | {py_type: 'app.bsky.feed.threadgate#followingRule'}
        | {py_type: 'app.bsky.feed.threadgate#listRule'}
      )[] | null
      hidden_replies: string[] | null
      py_type: 'app.bsky.feed.threadgate'
      [k: string]: unknown
    } | null
    uri: string | null
    py_type: 'app.bsky.feed.defs#threadgateView'
  } | null
  viewer: {
    embedding_disabled: boolean | null
    like: string | null
    pinned: boolean | null
    reply_disabled: boolean | null
    repost: string | null
    thread_muted: boolean | null
    py_type: 'app.bsky.feed.defs#viewerState'
  } | null
  py_type: 'app.bsky.feed.defs#postView'
}
