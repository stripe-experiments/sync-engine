const OFFSCREEN_PATH = 'src/offscreen.html'
const STRIPE_HOST_PATTERNS = [/^https:\/\/stripe\.com\//, /^https:\/\/[^/]*\.stripe\.com\//]

async function hasOffscreen(): Promise<boolean> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH)
  const filter = {
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [offscreenUrl],
  }
  const contexts = (await chrome.runtime.getContexts(filter)) as unknown[]
  return contexts.length > 0
}

let creating: Promise<void> | null = null

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  if (creating) return creating
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
      justification: 'Run Stripe sync engine and PGlite with persistent IndexedDB storage.',
    })
    .finally(() => {
      creating = null
    })
  await creating
}

function isStripeUrl(url: string | undefined): boolean {
  if (!url) return false
  return STRIPE_HOST_PATTERNS.some((re) => re.test(url))
}

async function enableSidePanelForTab(tabId: number, url: string | undefined): Promise<void> {
  if (isStripeUrl(url)) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'src/sidepanel/index.html',
      enabled: true,
    })
  } else {
    await chrome.sidePanel.setOptions({ tabId, enabled: false })
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    enableSidePanelForTab(tabId, tab.url).catch(() => {})
  }
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab) await enableSidePanelForTab(tabId, tab.url).catch(() => {})
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false

  if (message.kind === 'content:dashboard_ready' && sender.tab?.id != null) {
    enableSidePanelForTab(sender.tab.id, sender.tab.url).catch(() => {})
    sendResponse({ ok: true })
    return false
  }

  if (message.kind === 'panel:ensure_ready') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }

  return false
})
