export async function pipeline(..._streams: unknown[]): Promise<void> {
  throw new Error('stream/promises.pipeline is not available in browser')
}
export async function finished(_stream: unknown): Promise<void> {
  throw new Error('stream/promises.finished is not available in browser')
}
export default { pipeline, finished }
