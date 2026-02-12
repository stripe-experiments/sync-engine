'use client'

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { TableNodeData } from '@/lib/schemaLayout'

type TableNodeProps = {
  data: TableNodeData
}

const containerStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: 8,
  minWidth: 240,
  maxWidth: 320,
  boxShadow: '0 2px 4px rgba(0,0,0,0.08)',
  fontSize: 13,
}

const headerStyle: React.CSSProperties = {
  background: '#1a1a1a',
  color: '#fff',
  padding: '10px 14px',
  fontWeight: 600,
  fontSize: 14,
  borderTopLeftRadius: 7,
  borderTopRightRadius: 7,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const tableIconStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  opacity: 0.7,
}

const columnsContainerStyle: React.CSSProperties = {
  padding: '8px 0',
  maxHeight: 400,
  overflowY: 'auto',
}

const columnRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '4px 14px',
  gap: 8,
}

const columnNameStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
}

const columnTypeStyle: React.CSSProperties = {
  color: '#666',
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  background: '#f5f5f5',
  padding: '2px 6px',
  borderRadius: 4,
}

const pkBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  color: '#fff',
  background: '#f59e0b',
  padding: '2px 5px',
  borderRadius: 3,
  letterSpacing: '0.5px',
}

const nullableBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  color: '#888',
}

const fkBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  color: '#fff',
  background: '#6366f1',
  padding: '2px 5px',
  borderRadius: 3,
  letterSpacing: '0.5px',
}

const FK_PATTERNS = [
  'customer',
  'subscription',
  'invoice',
  'charge',
  'payment_intent',
  'payment_method',
  'product',
  'price',
  'plan',
  'coupon',
  'balance_transaction',
  'payout',
  'refund',
  'tax_rate',
  'discount',
]

function isForeignKey(columnName: string): boolean {
  if (columnName === 'id') return false
  if (FK_PATTERNS.includes(columnName)) return true
  if (columnName.endsWith('_id')) {
    const baseName = columnName.slice(0, -3)
    return FK_PATTERNS.includes(baseName)
  }
  return false
}

function TableNodeComponent({ data }: TableNodeProps) {
  const nodeData = data

  return (
    <div style={containerStyle}>
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: '#6366f1', width: 8, height: 8 }}
      />

      <div style={headerStyle}>
        <svg style={tableIconStyle} viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 3h18v18H3V3zm2 4v4h6V7H5zm8 0v4h6V7h-6zm-8 6v4h6v-4H5zm8 0v4h6v-4h-6z" />
        </svg>
        <span>{nodeData.tableName}</span>
      </div>

      <div style={columnsContainerStyle}>
        {nodeData.columns.map((column) => (
          <div key={column.name} style={columnRowStyle}>
            {column.primaryKey && <span style={pkBadgeStyle}>PK</span>}
            {!column.primaryKey && isForeignKey(column.name) && (
              <span style={fkBadgeStyle}>FK</span>
            )}
            <span style={columnNameStyle}>{column.name}</span>
            {column.nullable && <span style={nullableBadgeStyle}>?</span>}
            <span style={columnTypeStyle}>{column.type}</span>
          </div>
        ))}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: '#6366f1', width: 8, height: 8 }}
      />
    </div>
  )
}

export const TableNode = memo(TableNodeComponent)
