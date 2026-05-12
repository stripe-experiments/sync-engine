export function fileURLToPath(url: string | URL) {
  return String(url).replace(/^file:\/\//, '')
}
export function pathToFileURL(p: string) {
  return new URL(`file://${p}`)
}
export { URL, URLSearchParams } from 'url'
export default { fileURLToPath, pathToFileURL, URL, URLSearchParams }
