'use client'

import { useCallback } from 'react'
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { TableNode } from './TableNode'
import type { TableNodeData } from '@/lib/schemaLayout'

interface SchemaCanvasProps {
  initialNodes: Node<TableNodeData>[]
  initialEdges: Edge[]
}

const containerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  background: '#fafafa',
}

const miniMapStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: 4,
}

const nodeTypes: NodeTypes = {
  tableNode: TableNode as NodeTypes['tableNode'],
}

export function SchemaCanvas({ initialNodes, initialEdges }: SchemaCanvasProps) {
  const nodesState = useNodesState(initialNodes)
  const edgesState = useEdgesState(initialEdges)
  const nodes = nodesState[0]
  const onNodesChange = nodesState[2]
  const edges = edgesState[0]
  const onEdgesChange = edgesState[2]

  const onInit = useCallback(() => {
    // React Flow is ready
  }, [])

  return (
    <div style={containerStyle}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={onInit}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: false,
        }}
      >
        <Controls position="bottom-left" style={{ marginBottom: 10, marginLeft: 10 }} />
        <MiniMap
          position="bottom-right"
          style={miniMapStyle}
          nodeColor="#1a1a1a"
          maskColor="rgba(0,0,0,0.1)"
          pannable
          zoomable
        />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#ddd" />
      </ReactFlow>
    </div>
  )
}
