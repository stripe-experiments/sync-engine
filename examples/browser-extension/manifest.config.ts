import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Stripe Sync (PGlite)',
  version: '0.0.1',
  description: 'Sync Stripe data into a local PGlite database, in your browser.',
  minimum_chrome_version: '116',
  permissions: ['storage', 'sidePanel', 'offscreen', 'alarms'],
  host_permissions: [
    'https://api.stripe.com/*',
    'https://files.stripe.com/*',
    'https://*.stripe.com/*',
  ],
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  options_page: 'src/options/index.html',
  content_scripts: [
    {
      matches: ['https://stripe.com/*', 'https://*.stripe.com/*'],
      js: ['src/content.ts'],
      run_at: 'document_idle',
    },
  ],
  action: {
    default_title: 'Stripe Sync',
  },
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  web_accessible_resources: [
    {
      resources: ['src/offscreen.html'],
      matches: ['<all_urls>'],
    },
  ],
})
