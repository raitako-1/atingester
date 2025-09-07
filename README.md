# atingester: Bluesky Syncing Tools
This library for syncing data from the bluesky network.

Forked from [@atproto/sync](https://github.com/bluesky-social/atproto/tree/main/packages/sync)

[![NPM](https://img.shields.io/npm/v/atingester)](https://www.npmjs.com/package/atingester)
[![Github CI Status](https://github.com/raitako-1/atingester/actions/workflows/build.yml/badge.svg)](https://github.com/raitako-1/atingester/actions/workflows/build.yml)

### This tool can subscribes...
- **[Firehose](https://docs.bsky.app/docs/advanced-guides/firehose)** is an authenticated stream of events used to efficiently sync user updates (posts, likes, follows, handle changes, etc).
- **[Jetstream](https://github.com/jazware/jetstream)** is a streaming service that consumes Firehose and converts it into lightweight, friendly JSON.
- **[Turbostream](https://www.graze.social/docs/graze-turbostream)** is a real-time, hydrated repeater service built on top of Jetstream.

## Usage

It's basically the same as [here](https://github.com/bluesky-social/atproto/blob/main/packages/sync/README.md).

### Ingester ( Firehose / Jetstream / Turbostream )

```ts
import { Ingester } from 'atingester'
import { IdResolver } from '@atproto/identity'

const ingester = new Ingester('Firehose', {
  idResolver: new IdResolver(),
  handleEvent: async (evt) => {
    if (evt.event === 'create') {
      console.log(evt.record.text)
    }
  },
  onInfo: (info) => {
    console.info(info)
  },
  onError: (err: Error) => {
    console.error(err)
  },
  service: 'wss://bsky.network',
  subscriptionReconnectDelay: 3000,
  unauthenticatedCommits: true,
  unauthenticatedHandles: true,
  compress: true,
  filterCollections: ['app.bsky.feed.post'],
  filterDids: ['did:plc:abcde....'],
  excludeIdentity: true,
  excludeAccount: true,
  excludeCommit: false,
  excludeSync: true,
})
ingester.start()

await ingester.destroy()
```

### Firehose

```ts
import { Firehose } from 'atingester'
import { IdResolver } from '@atproto/identity'

const firehose = new Firehose({
  idResolver: new IdResolver(),
  handleEvent: async (evt) => {
    if (evt.event === 'create') {
      console.log(evt.record.text)
    }
  },
  onInfo: (info) => {
    console.info(info)
  },
  onError: (err: Error) => {
    console.error(err)
  },
  service: 'wss://bsky.network',
  filterCollections: ['app.bsky.feed.post'],
  filterDids: ['did:plc:abcde....'],
  excludeIdentity: true,
  excludeAccount: true,
  excludeSync: true,
})
firehose.start()

await firehose.destroy()
```

### Jetstream

```ts
import { Jetstream } from 'atingester'
import { IdResolver } from '@atproto/identity'

const jetstream = new Jetstream({
  idResolver: new IdResolver(),
  handleEvent: async (evt) => {
    if (evt.event === 'create') {
      console.log(evt.record.text)
    }
  },
  onInfo: (info) => {
    console.info(info)
  },
  onError: (err: Error) => {
    console.error(err)
  },
  service: 'wss://jetstream1.us-east.bsky.network',
  compress: true,
  filterCollections: ['app.bsky.feed.post'],
  filterDids: ['did:plc:abcde....'],
  excludeIdentity: true,
  excludeAccount: true,
})
jetstream.start()

await jetstream.destroy()
```

### Turbostream

```ts
import { Turbostream } from 'atingester'
import { IdResolver } from '@atproto/identity'

const turbostream = new Turbostream({
  handleEvent: async (evt) => {
    if (evt.event === 'create') {
      console.log(evt.record.text)
    }
  },
  onInfo: (info) => {
    console.info(info)
  },
  onError: (err: Error) => {
    console.error(err)
  },
  service: 'wss://api.graze.social',
  filterDids: ['did:plc:abcde....'],
})
turbostream.start()

await turbostream.destroy()
```
