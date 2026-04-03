import type { Pipeline } from './createSchemas.js'

export type { Pipeline }

export interface PipelineStore {
  get(id: string): Promise<Pipeline>
  set(id: string, pipeline: Pipeline): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<Pipeline[]>
}
