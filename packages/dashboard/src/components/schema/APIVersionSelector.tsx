'use client'

import { useState, useEffect } from 'react'

interface APIVersionSelectorProps {
  selectedVersion: string
  onVersionChange: (version: string) => void
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const labelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: '#333',
}

const selectStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 14,
  border: '1px solid #ddd',
  borderRadius: 6,
  background: '#fff',
  cursor: 'pointer',
  minWidth: 200,
}

export function APIVersionSelector({ selectedVersion, onVersionChange }: APIVersionSelectorProps) {
  const [versions, setVersions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchVersions() {
      try {
        const response = await fetch('/api/versions')
        if (!response.ok) {
          throw new Error('Failed to fetch versions')
        }
        const data = await response.json()
        setVersions(data.versions || [])

        if (data.versions?.length > 0 && !selectedVersion) {
          onVersionChange(data.versions[0])
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchVersions()
  }, [])

  if (loading) {
    return (
      <div style={containerStyle}>
        <span style={labelStyle}>API Version:</span>
        <span style={{ color: '#666', fontSize: 14 }}>Loading versions...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div style={containerStyle}>
        <span style={labelStyle}>API Version:</span>
        <span style={{ color: '#c00', fontSize: 14 }}>Error: {error}</span>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <label htmlFor="version-select" style={labelStyle}>
        API Version:
      </label>
      <select
        id="version-select"
        value={selectedVersion}
        onChange={(e) => onVersionChange(e.target.value)}
        style={selectStyle}
      >
        {versions.map((version) => (
          <option key={version} value={version}>
            {version}
          </option>
        ))}
      </select>
    </div>
  )
}
