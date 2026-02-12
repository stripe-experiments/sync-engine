'use client'

import { useState, useEffect } from 'react'
import { APIVersionSelector } from '@/components/schema/APIVersionSelector'
import { SchemaCanvas } from '@/components/schema/SchemaCanvas'
import { schemaToReactFlow, type TableNodeData } from '@/lib/schemaLayout'
import type { Node, Edge } from '@xyflow/react'
import type { TableDefinition } from 'stripe-experiment-sync/openapi'

const pageContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 24px',
  borderBottom: '1px solid #eee',
  background: '#fff',
}

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  margin: 0,
}

const versionInfoStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#666',
  marginLeft: 16,
}

const canvasContainerStyle: React.CSSProperties = {
  flex: 1,
  position: 'relative',
}

const loadingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: '#666',
  fontSize: 16,
}

const errorStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: '#c00',
  fontSize: 16,
  padding: 40,
  textAlign: 'center',
}

const statsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  fontSize: 13,
  color: '#666',
}

const statBadgeStyle: React.CSSProperties = {
  background: '#f5f5f5',
  padding: '4px 10px',
  borderRadius: 4,
}

interface SchemaResponse {
  version: string
  tables: TableDefinition[]
  errors?: string[]
}

export default function SchemaPage() {
  const [selectedVersion, setSelectedVersion] = useState('current')
  const [apiVersion, setApiVersion] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Node<TableNodeData>[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchSchema() {
      if (!selectedVersion) return

      setLoading(true)
      setError(null)

      try {
        const response = await fetch(`/api/schema?version=${selectedVersion}`)
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || 'Failed to fetch schema')
        }

        const data: SchemaResponse = await response.json()
        setApiVersion(data.version)

        if (data.tables.length === 0) {
          throw new Error('No tables found in schema')
        }

        const { nodes: layoutedNodes, edges: inferredEdges } = schemaToReactFlow(data.tables, 'LR')

        setNodes(layoutedNodes)
        setEdges(inferredEdges)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchSchema()
  }, [selectedVersion])

  return (
    <div style={pageContainerStyle}>
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h1 style={titleStyle}>Schema Visualizer</h1>
          {apiVersion && <span style={versionInfoStyle}>Stripe API {apiVersion}</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div style={statsStyle}>
            <span style={statBadgeStyle}>{nodes.length} tables</span>
            <span style={statBadgeStyle}>{edges.length} relationships</span>
          </div>
          <APIVersionSelector
            selectedVersion={selectedVersion}
            onVersionChange={setSelectedVersion}
          />
        </div>
      </header>

      <div style={canvasContainerStyle}>
        {loading && <div style={loadingStyle}>Loading schema...</div>}

        {error && <div style={errorStyle}>{error}</div>}

        {!loading && !error && nodes.length > 0 && (
          <SchemaCanvas initialNodes={nodes} initialEdges={edges} />
        )}
      </div>
    </div>
  )
}
