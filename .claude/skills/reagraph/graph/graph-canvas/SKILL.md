# GraphCanvas

Main entry point for reagraph. Wraps the Three.js canvas, scene, camera controls, and lasso selection into a single component. Pass `nodes` and `edges` data along with layout, theme, and interaction configuration.

## Import

```tsx
import { GraphCanvas } from 'reagraph';
```

## GraphCanvas Props

### Data

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `nodes` | `GraphNode[]` | — | Node data (required) |
| `edges` | `GraphEdge[]` | — | Edge data (required) |

### Layout & Sizing

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `layoutType` | `LayoutTypes` | `'forceDirected2d'` | Layout algorithm |
| `layoutOverrides` | `LayoutOverrides` | — | Advanced layout parameters |
| `sizingType` | `SizingType` | `'default'` | Node sizing strategy |
| `sizingAttribute` | `string` | — | Attribute name for `'attribute'` sizing |
| `defaultNodeSize` | `number` | `7` | Default node size |
| `minNodeSize` | `number` | `5` | Min size for auto-sizing |
| `maxNodeSize` | `number` | `15` | Max size for auto-sizing |
| `clusterAttribute` | `string` | — | Node attribute for clustering |

### Appearance

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `theme` | `Theme` | `lightTheme` | Theme object |
| `animated` | `boolean` | `true` | Animate layout transitions |
| `labelType` | `LabelVisibilityType` | `'auto'` | Label visibility mode |
| `labelFontUrl` | `string` | Google Roboto | Custom font URL (.ttf/.otf/.woff) |
| `edgeLabelPosition` | `EdgeLabelPosition` | — | Edge label placement |
| `edgeArrowPosition` | `EdgeArrowPosition` | — | Arrow placement |
| `edgeInterpolation` | `EdgeInterpolation` | `'linear'` | Edge shape |

### Camera

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `cameraMode` | `CameraMode` | `'pan'` | Camera interaction mode |
| `maxDistance` | `number` | `50000` | Max camera distance |
| `minDistance` | `number` | `1000` | Min camera distance |
| `minZoom` | `number` | `1` | Min zoom (orthographic) |
| `maxZoom` | `number` | `100` | Max zoom (orthographic) |

### Interaction

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `disabled` | `boolean` | `false` | Disable all interactions |
| `draggable` | `boolean` | `false` | Allow node dragging |
| `constrainDragging` | `boolean` | `false` | Constrain dragging to cluster bounds |
| `lassoType` | `LassoType` | `'none'` | Lasso selection mode (`'none'`/`'all'`/`'node'`/`'edge'`) |
| `aggregateEdges` | `boolean` | `false` | Merge parallel edges |
| `selections` | `string[]` | — | Selected node/edge IDs |
| `actives` | `string[]` | — | Active (highlighted) IDs |
| `collapsedNodeIds` | `string[]` | — | Collapsed node IDs |

### Custom Rendering

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `renderNode` | `NodeRenderer` | — | Custom node render function |
| `onRenderCluster` | `ClusterRenderer` | — | Custom cluster render function |
| `contextMenu` | `(event: ContextMenuEvent) => ReactNode` | — | Context menu renderer |
| `children` | `ReactNode` | — | Extra Three.js children (e.g. lights) |
| `glOptions` | `object` | `{}` | WebGL context options |

### Event Callbacks

| Prop | Signature | Description |
|------|-----------|-------------|
| `onCanvasClick` | `(event: MouseEvent) => void` | Canvas background clicked |
| `onNodeClick` | `(node, collapseProps?, event?) => void` | Node clicked |
| `onNodeDoubleClick` | `(node, event) => void` | Node double-clicked |
| `onNodePointerOver` | `(node, event) => void` | Pointer enters node |
| `onNodePointerOut` | `(node, event) => void` | Pointer leaves node |
| `onNodeContextMenu` | `(node, menuProps?) => void` | Node right-clicked |
| `onNodeDragged` | `(node) => void` | Node drag completed |
| `onEdgeClick` | `(edge, event?) => void` | Edge clicked |
| `onEdgePointerOver` | `(edge, event) => void` | Pointer enters edge |
| `onEdgePointerOut` | `(edge, event) => void` | Pointer leaves edge |
| `onEdgeContextMenu` | `(edge?) => void` | Edge right-clicked |
| `onClusterClick` | `(cluster, event) => void` | Cluster clicked |
| `onClusterPointerOver` | `(cluster, event) => void` | Pointer enters cluster |
| `onClusterPointerOut` | `(cluster, event) => void` | Pointer leaves cluster |
| `onClusterDragged` | `(cluster) => void` | Cluster drag completed |
| `onLasso` | `(selections: string[]) => void` | Lasso selection changed |
| `onLassoEnd` | `(selections: string[]) => void` | Lasso selection ended |

## Ref Methods (GraphCanvasRef)

Access via `useRef<GraphCanvasRef>()`:

| Method | Description |
|--------|-------------|
| `centerGraph(nodeIds?, opts?)` | Center camera on specific nodes |
| `fitNodesInView(nodeIds?, opts?)` | Fit nodes into viewport |
| `zoomIn()` / `zoomOut()` | Zoom camera |
| `dollyIn(distance)` / `dollyOut(distance)` | Move camera closer/further |
| `panLeft()` / `panRight()` / `panUp()` / `panDown()` | Pan camera |
| `resetControls(animated?)` | Reset camera to initial position |
| `freeze()` / `unFreeze()` | Freeze/unfreeze camera controls |
| `exportCanvas()` | Export canvas as data URL |
| `getGraph()` | Get Graphology graph instance |
| `getControls()` | Get Three.js camera controls |

## Basic Usage

```tsx
import { GraphCanvas } from 'reagraph';

<GraphCanvas
  nodes={[
    { id: '1', label: 'Node 1' },
    { id: '2', label: 'Node 2' },
  ]}
  edges={[
    { id: 'e1', source: '1', target: '2', label: 'connects' },
  ]}
/>
```

## With Ref

```tsx
import { GraphCanvas, GraphCanvasRef } from 'reagraph';

const ref = useRef<GraphCanvasRef>(null);

<GraphCanvas ref={ref} nodes={nodes} edges={edges} />

// Later:
ref.current?.centerGraph();
ref.current?.fitNodesInView(['1', '2']);
```

## Dark Theme

```tsx
import { GraphCanvas, darkTheme } from 'reagraph';

<GraphCanvas nodes={nodes} edges={edges} theme={darkTheme} />
```

## 3D Layout

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  layoutType="forceDirected3d"
  cameraMode="orbit"
/>
```

## Draggable Nodes

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  draggable
  onNodeDragged={(node) => console.log('Dragged:', node.id)}
/>
```
