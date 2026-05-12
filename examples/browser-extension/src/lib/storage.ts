const API_KEY = 'stripe_api_key'
const SYNC_STATE = 'sync_state'

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local
}

async function readKey(key: string): Promise<unknown> {
  if (hasChromeStorage()) {
    const { [key]: value } = await chrome.storage.local.get(key)
    return value
  }
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(key)
    return raw == null ? undefined : JSON.parse(raw)
  }
  return undefined
}

async function writeKey(key: string, value: unknown): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [key]: value })
    return
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, JSON.stringify(value))
  }
}

async function removeKey(key: string): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(key)
    return
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(key)
  }
}

export async function getApiKey(): Promise<string | undefined> {
  const value = await readKey(API_KEY)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function setApiKey(value: string): Promise<void> {
  await writeKey(API_KEY, value)
}

export async function clearApiKey(): Promise<void> {
  await removeKey(API_KEY)
}

export async function loadSyncState(): Promise<unknown> {
  return readKey(SYNC_STATE)
}

export async function saveSyncState(state: unknown): Promise<void> {
  await writeKey(SYNC_STATE, state)
}

export async function clearSyncState(): Promise<void> {
  await removeKey(SYNC_STATE)
}
