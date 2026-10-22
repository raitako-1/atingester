import { type FirehoseOptions } from '@atproto/sync'
import { init } from '@bokuweb/zstd-wasm'
import { Firehose, Jetstream, JetstreamV1, Turbostream } from './stream/index.js'
import type { IngesterEvent } from './types.js'

export const initIngester = async (): Promise<void> => await init()

export type SubscriptionMode =
  | 'Firehose'
  | 'Jetstream'
  | 'Jetstream-v1'
  | 'Jetstream-v2'
  | 'Turbostream'

export type IngesterOptions = Omit<FirehoseOptions, 'handleEvent'> & {
  compress?: boolean
  filterDids?: string[]
  handleEvent: (evt: IngesterEvent) => Awaited<void>
  onInfo: (info: string) => void
}

export class Ingester {
  private ingester: Firehose | Jetstream | JetstreamV1 | Turbostream

  constructor(mode: SubscriptionMode, opts: IngesterOptions) {
    if (mode === 'Firehose') this.ingester = new Firehose(opts)
    else if (mode === 'Jetstream') this.ingester = new Jetstream(opts)
    else if (mode === 'Jetstream-v1') this.ingester = new JetstreamV1(opts)
    else if (mode === 'Jetstream-v2') this.ingester = new Jetstream(opts)
    else if (mode === 'Turbostream') this.ingester = new Turbostream(opts)
    else throw new Error('Invalid ingester subscription mode.')
  }

  async start(): Promise<void> {
    await this.ingester.start()
  }

  async destroy(): Promise<void> {
    await this.ingester.destroy()
  }
}
