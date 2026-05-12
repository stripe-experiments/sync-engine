import { useEffect, useState } from 'react'
import { clearApiKey, getApiKey, setApiKey } from '../lib/storage'

export default function App() {
  const [value, setValue] = useState('')
  const [stored, setStored] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getApiKey().then((k) => setStored(k))
  }, [])

  const onSave = async () => {
    if (!value.trim()) return
    setBusy(true)
    try {
      await setApiKey(value.trim())
      setStored(value.trim())
      setValue('')
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setBusy(false)
    }
  }

  const onClear = async () => {
    if (!confirm('Forget the saved API key?')) return
    setBusy(true)
    try {
      await clearApiKey()
      setStored(undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={containerStyle}>
      <h1 style={{ fontSize: 22 }}>Stripe Sync · Settings</h1>
      <p style={{ color: '#444' }}>
        Paste a Stripe API key. Restricted keys (<code>rk_…</code>) with read-only permissions are
        strongly recommended. The key never leaves your browser — it is stored locally via{' '}
        <code>chrome.storage.local</code>.
      </p>

      <section style={sectionStyle}>
        <label style={labelStyle}>API key</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={stored ? 'A key is saved. Paste to replace.' : 'sk_live_… or rk_live_…'}
          style={inputStyle}
          autoComplete="off"
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={onSave} disabled={busy || !value.trim()} style={buttonStyle}>
            Save
          </button>
          <button onClick={onClear} disabled={busy || !stored} style={buttonStyleSecondary}>
            Forget saved key
          </button>
          {saved && <span style={{ color: '#0a7', alignSelf: 'center' }}>Saved.</span>}
        </div>
        {stored && (
          <p style={{ color: '#666', marginTop: 8 }}>
            Currently saved: <code>{maskKey(stored)}</code>
          </p>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Next steps</h2>
        <ol>
          <li>Open a Stripe tab (e.g. <code>dashboard.stripe.com</code>).</li>
          <li>Click the extension icon to open the side panel.</li>
          <li>Press <strong>Start sync</strong>.</li>
        </ol>
      </section>
    </div>
  )
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}

const containerStyle: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, sans-serif',
  maxWidth: 640,
  margin: '40px auto',
  padding: '0 16px',
  fontSize: 14,
}
const sectionStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
}
const labelStyle: React.CSSProperties = { fontWeight: 600, display: 'block', marginBottom: 6 }
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 13,
  boxSizing: 'border-box',
  borderRadius: 4,
  border: '1px solid #ccc',
}
const buttonStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 4,
  border: '1px solid #635bff',
  background: '#635bff',
  color: 'white',
  cursor: 'pointer',
}
const buttonStyleSecondary: React.CSSProperties = {
  ...buttonStyle,
  background: 'white',
  color: '#635bff',
}
