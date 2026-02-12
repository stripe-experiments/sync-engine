/**
 * Schema Layout Utilities
 *
 * Converts TableDefinition arrays to React Flow nodes/edges and applies
 * automatic layout using the dagre library.
 */

import type { Node, Edge } from '@xyflow/react'
import dagre from 'dagre'
import type { TableDefinition } from 'stripe-experiment-sync/openapi'

/**
 * Node data structure for TableNode component
 */
export interface TableNodeData {
  tableName: string
  columns: Array<{
    name: string
    type: string
    primaryKey: boolean
    nullable: boolean
  }>
  [key: string]: unknown
}

/**
 * Convert TableDefinition array to React Flow nodes
 */
export function tablesToNodes(tables: TableDefinition[]): Node<TableNodeData>[] {
  return tables.map((table) => ({
    id: table.name,
    type: 'tableNode',
    position: { x: 0, y: 0 },
    data: {
      tableName: table.name,
      columns: table.columns.map((col) => ({
        name: col.name,
        type: col.type,
        primaryKey: col.primaryKey,
        nullable: col.nullable,
      })),
    },
  }))
}

/**
 * Known Stripe FK relationships based on common patterns.
 * Maps column names to their target table names.
 */
const KNOWN_FK_MAPPINGS: Record<string, string> = {
  customer: 'customers',
  subscription: 'subscriptions',
  invoice: 'invoices',
  charge: 'charges',
  payment_intent: 'payment_intents',
  payment_method: 'payment_methods',
  product: 'products',
  price: 'prices',
  plan: 'plans',
  coupon: 'coupons',
  balance_transaction: 'balance_transactions',
  payout: 'payouts',
  refund: 'refunds',
  tax_rate: 'tax_rates',
  discount: 'discounts',
}

/**
 * Pluralize a singular noun for table name matching
 */
function pluralize(singular: string): string {
  if (singular.endsWith('y')) {
    return singular.slice(0, -1) + 'ies'
  }
  if (singular.endsWith('s') || singular.endsWith('sh') || singular.endsWith('ch')) {
    return singular + 'es'
  }
  return singular + 's'
}

/**
 * Infer relationships between tables based on naming conventions.
 * Looks for columns that reference other tables via FK patterns.
 */
export function inferRelationships(tables: TableDefinition[]): Edge[] {
  const edges: Edge[] = []
  const tableNames = new Set(tables.map((t) => t.name))
  const seenEdges = new Set<string>()

  for (const table of tables) {
    for (const column of table.columns) {
      // Skip primary key
      if (column.name === 'id') continue

      let targetTable: string | null = null

      // Check if column name directly matches a known FK mapping
      if (KNOWN_FK_MAPPINGS[column.name]) {
        targetTable = KNOWN_FK_MAPPINGS[column.name]
      }
      // Check for columns ending in common FK patterns
      else if (column.name.endsWith('_id')) {
        // Remove _id suffix and try to find matching table
        const baseName = column.name.slice(0, -3)
        if (KNOWN_FK_MAPPINGS[baseName]) {
          targetTable = KNOWN_FK_MAPPINGS[baseName]
        } else {
          // Try pluralizing the base name
          targetTable = pluralize(baseName)
        }
      }
      // Check for columns that are just the entity name (e.g., "customer" column)
      else if (KNOWN_FK_MAPPINGS[column.name]) {
        targetTable = KNOWN_FK_MAPPINGS[column.name]
      }

      // Only add edge if target table exists in our schema
      if (targetTable && tableNames.has(targetTable) && targetTable !== table.name) {
        const edgeId = `${table.name}-${column.name}-${targetTable}`
        if (!seenEdges.has(edgeId)) {
          seenEdges.add(edgeId)
          edges.push({
            id: edgeId,
            source: table.name,
            target: targetTable,
            sourceHandle: column.name,
            label: column.name,
            animated: false,
            style: { stroke: '#6366f1', strokeWidth: 2 },
            labelStyle: { fontSize: 10, fill: '#666' },
            labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
          })
        }
      }
    }
  }

  return edges
}

/**
 * Layout direction for dagre algorithm
 */
export type LayoutDirection = 'TB' | 'BT' | 'LR' | 'RL'

/**
 * Apply dagre layout to position nodes automatically
 */
export function layoutWithDagre(
  nodes: Node<TableNodeData>[],
  edges: Edge[],
  direction: LayoutDirection = 'LR'
): Node<TableNodeData>[] {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  const nodeWidth = 280
  const nodeHeight = 200

  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: 80,
    ranksep: 100,
    marginx: 50,
    marginy: 50,
  })

  for (const node of nodes) {
    const estimatedHeight = Math.max(nodeHeight, 60 + node.data.columns.length * 24)
    dagreGraph.setNode(node.id, { width: nodeWidth, height: estimatedHeight })
  }

  for (const edge of edges) {
    dagreGraph.setEdge(edge.source, edge.target)
  }

  dagre.layout(dagreGraph)

  return nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeWithPosition.height / 2,
      },
    }
  })
}

/**
 * Convert schema to React Flow elements with automatic layout
 */
export function schemaToReactFlow(
  tables: TableDefinition[],
  direction: LayoutDirection = 'LR'
): { nodes: Node<TableNodeData>[]; edges: Edge[] } {
  const nodes = tablesToNodes(tables)
  const edges = inferRelationships(tables)
  const layoutedNodes = layoutWithDagre(nodes, edges, direction)

  return { nodes: layoutedNodes, edges }
}
