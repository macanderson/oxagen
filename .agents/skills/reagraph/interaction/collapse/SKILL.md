# Collapse

Expand and collapse node hierarchies. Collapsed nodes hide their descendants while maintaining the graph structure.

## Import

```tsx
import { useCollapse, GraphCanvas } from 'reagraph';
```

## useCollapse Hook

### Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `collapsedNodeIds` | `string[]` | `[]` | Currently collapsed node IDs |
| `nodes` | `GraphNode[]` | `[]` | Node data |
| `edges` | `GraphEdge[]` | `[]` | Edge data |

### Return Value

| Property | Type | Description |
|----------|------|-------------|
| `getIsCollapsed` | `(nodeId: string) => boolean` | Check if a node is collapsed |
| `getExpandPathIds` | `(nodeId: string) => string[]` | Get IDs to expand to reveal a node |

## Basic Usage

```tsx
import { GraphCanvas, useCollapse } from 'reagraph';

const [collapsedIds, setCollapsedIds] = useState<string[]>([]);

<GraphCanvas
  nodes={nodes}
  edges={edges}
  collapsedNodeIds={collapsedIds}
  onNodeClick={(node, { canCollapse, isCollapsed }) => {
    if (canCollapse) {
      setCollapsedIds((prev) =>
        isCollapsed
          ? prev.filter((id) => id !== node.id)
          : [...prev, node.id]
      );
    }
  }}
/>
```

## With Context Menu

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  collapsedNodeIds={collapsedIds}
  contextMenu={({ data, onClose, canCollapse, isCollapsed, onCollapse }) => (
    <RadialMenu
      onClose={onClose}
      items={[
        ...(canCollapse
          ? [{
              label: isCollapsed ? 'Expand' : 'Collapse',
              onClick: () => { onCollapse(); onClose(); },
            }]
          : []),
      ]}
    />
  )}
/>
```

## Checking Collapse State

```tsx
const { getIsCollapsed, getExpandPathIds } = useCollapse({
  collapsedNodeIds,
  nodes,
  edges,
});

// Check if a specific node is collapsed
const isHidden = getIsCollapsed('node-5');

// Get path to expand to reveal a hidden node
const pathToExpand = getExpandPathIds('node-5');
```

## Notes

- Nodes need `parents` property or outbound edges to establish hierarchy
- `canCollapse` in the click/context-menu callback indicates whether a node has children
- Collapsing a node hides all its descendants
- `collapsedNodeIds` is a controlled prop — manage it in your state
- `onCollapse` in context menu events toggles the collapse state for you
