---
name: reagraph
description: Use when building interactive 2D or 3D graph or network visualizations in React with the reagraph library (GraphCanvas, node-link diagrams, force-directed layouts). Covers data shapes (GraphNode, GraphEdge), 16 layout algorithms, selection, lasso, camera controls, sizing strategies, and theming.
---

# Reagraph

Reagraph is a WebGL-powered graph visualization library for React built on **Three.js**, **React Three Fiber**, **D3**, and **Graphology**. It renders interactive node-link diagrams in 2D and 3D with force-directed and hierarchical layouts.

## Installation

```bash
npm install reagraph
```

## Basic Setup

```tsx
import { GraphCanvas } from 'reagraph';

const nodes = [
  { id: 'n-1', label: 'Node 1' },
  { id: 'n-2', label: 'Node 2' },
  { id: 'n-3', label: 'Node 3' },
];

const edges = [
  { id: 'e-1', source: 'n-1', target: 'n-2', label: 'Edge 1' },
  { id: 'e-2', source: 'n-1', target: 'n-3', label: 'Edge 2' },
];

function App() {
  return (
    <GraphCanvas nodes={nodes} edges={edges} />
  );
}
```

## Data Shapes

### GraphNode

```ts
interface GraphNode {
  id: string;           // Unique ID (required)
  label?: string;       // Display label
  subLabel?: string;    // Secondary label
  size?: number;        // Node size
  fill?: string;        // Override fill color
  icon?: string;        // Icon URL
  cluster?: string;     // Cluster group ID
  parents?: string[];   // Parent node IDs (for hierarchy)
  data?: any;           // Custom metadata
  labelVisible?: boolean; // Force label visibility
  fx?: number;          // Fixed X position
  fy?: number;          // Fixed Y position
  fz?: number;          // Fixed Z position
}
```

### GraphEdge

```ts
interface GraphEdge {
  id: string;           // Unique ID (required)
  source: string;       // Source node ID (required)
  target: string;       // Target node ID (required)
  label?: string;       // Display label
  subLabel?: string;    // Secondary label
  size?: number;        // Edge thickness
  fill?: string;        // Override fill color
  dashed?: boolean;     // Dashed line style
  dashArray?: [number, number]; // [dashSize, gapSize]
  labelVisible?: boolean; // Force label visibility
  interpolation?: 'linear' | 'curved'; // Edge shape
  arrowPlacement?: 'none' | 'mid' | 'end'; // Arrow position
  subLabelPlacement?: 'below' | 'above'; // SubLabel position
}
```

## Common Patterns

- **Import from barrel**: Always `import { Component } from 'reagraph'`
- **Ref access**: Use `ref` on `GraphCanvas` for imperative methods (`centerGraph`, `fitNodesInView`, `exportCanvas`)
- **Per-node styling**: Set `fill`, `size`, `icon` directly on `GraphNode` objects to override theme defaults
- **Per-edge styling**: Set `fill`, `dashed`, `interpolation` directly on `GraphEdge` objects
- **3D layouts**: Append `3d` suffix to layout names (e.g. `forceDirected3d`, `treeTd3d`)
- **Sizing strategies**: Use `sizingType` prop to auto-size nodes by pagerank, centrality, or custom attribute

## Component Index

### Graph
GraphCanvas, GraphScene

### Nodes
Sphere, SphereWithIcon, SphereWithSvg, Svg, Badge, custom NodeRenderer

### Edges
Edge, Arrow, self-loops, dashed, curved, edge aggregation

### Layout
16 layout algorithms: forceDirected, circular, concentric, tree, radial, hierarchical, nooverlap, forceatlas2, custom

### Interaction
useSelection, Lasso, CameraControls, useCenterGraph, RadialMenu, useCollapse

### Styling
Theme (light/dark), SizingType (pagerank, centrality, attribute)
