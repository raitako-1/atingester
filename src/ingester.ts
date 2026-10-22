import { type FirehoseOptions } from '@atproto/sync'
import { init } from '@bokuweb/zstd-wasm'
import { Firehose, Jetstream, Turbostream } from './stream/index.js'
import type { IngesterEvent } from './types.js'

export const initIngester = async (): Promise<void> => await init()

export type SubscriptionMode = 'Firehose' | 'Jetstream' | 'Turbostream'

export type IngesterOptions = Omit<FirehoseOptions, 'handleEvent'> & {
  compress?: boolean
  filterDids?: string[]
  handleEvent: (evt: IngesterEvent) => Awaited<void>
  onInfo: (info: string) => void
}

export class Ingester {
  private ingester: Firehose | Jetstream | Turbostream

  constructor(mode: SubscriptionMode, opts: IngesterOptions) {
    if (mode === 'Firehose') this.ingester = new Firehose(opts)
    else if (mode === 'Jetstream') this.ingester = new Jetstream(opts)
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
