# Selection

Node and edge selection with single, multi, modifier-key, lasso, and path-based modes.

## Import

```tsx
import { useSelection, GraphCanvas } from 'reagraph';
```

## useSelection Hook

### Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `ref` | `RefObject<GraphCanvasRef>` | — | Graph ref (required) |
| `nodes` | `GraphNode[]` | — | Node data |
| `edges` | `GraphEdge[]` | — | Edge data |
| `selections` | `string[]` | — | Controlled selections |
| `actives` | `string[]` | — | Default active highlights |
| `type` | `SelectionTypes` | `'single'` | Selection mode |
| `pathSelectionType` | `PathSelectionTypes` | `'direct'` | Path selection mode |
| `pathHoverType` | `PathSelectionTypes` | `'out'` | Path hover highlighting |
| `focusOnSelect` | `boolean \| 'singleOnly'` | `true` | Center camera on selection |
| `disabled` | `boolean` | — | Disable selection |
| `onSelection` | `(ids: string[]) => void` | — | Selection change callback |

### Return Value

| Property | Type | Description |
|----------|------|-------------|
| `selections` | `string[]` | Current selected IDs |
| `actives` | `string[]` | Active/highlighted IDs |
| `clearSelections` | `(ids?: string[]) => void` | Clear selections |
| `addSelection` | `(id: string) => void` | Add to selection |
| `removeSelection` | `(id: string) => void` | Remove from selection |
| `toggleSelection` | `(id: string) => void` | Toggle selection |
| `setSelections` | `(ids: string[]) => void` | Replace selections |
| `selectNodePaths` | `(source, target) => void` | Select path between nodes |
| `onNodeClick` | handler | Pass to GraphCanvas |
| `onCanvasClick` | handler | Pass to GraphCanvas |
| `onNodePointerOver` | handler | Pass to GraphCanvas |
| `onNodePointerOut` | handler | Pass to GraphCanvas |
| `onLasso` | handler | Pass to GraphCanvas |
| `onLassoEnd` | handler | Pass to GraphCanvas |

## SelectionTypes

| Type | Description |
|------|-------------|
| `'single'` | Click to select one node (default) |
| `'multi'` | Click to toggle, accumulates selections |
| `'multiModifier'` | Hold Shift/Ctrl/Cmd to multi-select |

## PathSelectionTypes

| Type | Description |
|------|-------------|
| `'direct'` | Direct connections only (default) |
| `'out'` | Outbound path from node |
| `'in'` | Inbound path to node |
| `'all'` | All connected paths |

## LassoType

| Type | Description |
|------|-------------|
| `'none'` | No lasso (default) |
| `'all'` | Lasso selects nodes and edges |
| `'node'` | Lasso selects nodes only |
| `'edge'` | Lasso selects edges only |

## Basic Selection

```tsx
import { GraphCanvas, GraphCanvasRef, useSelection } from 'reagraph';

const ref = useRef<GraphCanvasRef>(null);

const {
  selections,
  actives,
  onNodeClick,
  onCanvasClick,
} = useSelection({
  ref,
  nodes,
  edges,
  type: 'single',
});

<GraphCanvas
  ref={ref}
  nodes={nodes}
  edges={edges}
  selections={selections}
  actives={actives}
  onNodeClick={onNodeClick}
  onCanvasClick={onCanvasClick}
/>
```

## Multi-Select with Modifier Key

```tsx
const { selections, actives, ...handlers } = useSelection({
  ref,
  nodes,
  edges,
  type: 'multiModifier',
});
```

## Lasso Selection

```tsx
const { selections, actives, onLasso, onLassoEnd, ...handlers } = useSelection({
  ref,
  nodes,
  edges,
  type: 'multi',
});

<GraphCanvas
  ref={ref}
  nodes={nodes}
  edges={edges}
  selections={selections}
  actives={actives}
  lassoType="node"
  onLasso={onLasso}
  onLassoEnd={onLassoEnd}
  {...handlers}
/>
```

## Selection Callback

```tsx
const { selections, ...handlers } = useSelection({
  ref,
  nodes,
  edges,
  onSelection: (ids) => console.log('Selected:', ids),
});
```

## Notes

- `useSelection` returns event handlers that must be spread onto `GraphCanvas`
- `actives` highlights adjacent nodes/edges around the selection
- `focusOnSelect` centers the camera on the selected node
- `pathHoverType="out"` highlights outbound connections when hovering
