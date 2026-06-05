# Context Menu

Right-click menus for nodes and edges. Includes a built-in `RadialMenu` component with pie-slice layout, or use the `contextMenu` prop for fully custom menus.

## Import

```tsx
import { GraphCanvas, RadialMenu } from 'reagraph';
```

## RadialMenu Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `items` | `MenuItem[]` | — | Menu items (required) |
| `radius` | `number` | `175` | Outer radius |
| `innerRadius` | `number` | `25` | Inner radius |
| `startOffsetAngle` | `number` | `0` | Starting angle offset |
| `className` | `string` | — | CSS class |
| `onClose` | `(event) => void` | — | Close callback |

## MenuItem

| Property | Type | Description |
|----------|------|-------------|
| `label` | `string` | Menu item text (required) |
| `icon` | `ReactNode` | Optional icon element |
| `disabled` | `boolean` | Disable the item |
| `className` | `string` | CSS class for the slice |
| `onClick` | `(event) => void` | Click handler |

## ContextMenuEvent

Passed to the `contextMenu` renderer:

| Property | Type | Description |
|----------|------|-------------|
| `data` | `InternalGraphNode \| InternalGraphEdge` | Node or edge data |
| `onClose` | `() => void` | Close the menu |
| `canCollapse` | `boolean` | Whether node can be collapsed |
| `isCollapsed` | `boolean` | Whether node is collapsed |
| `onCollapse` | `() => void` | Toggle collapse |

## Basic Radial Context Menu

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  contextMenu={({ data, onClose }) => (
    <RadialMenu
      onClose={onClose}
      items={[
        {
          label: 'Details',
          onClick: () => {
            console.log(data);
            onClose();
          },
        },
        {
          label: 'Delete',
          onClick: () => {
            handleDelete(data.id);
            onClose();
          },
        },
      ]}
    />
  )}
/>
```

## Context Menu with Collapse

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  contextMenu={({ data, onClose, canCollapse, isCollapsed, onCollapse }) => (
    <RadialMenu
      onClose={onClose}
      items={[
        { label: 'Info', onClick: () => console.log(data) },
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

## Custom HTML Context Menu

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  contextMenu={({ data, onClose }) => (
    <div style={{
      background: '#fff',
      border: '1px solid #ddd',
      borderRadius: 4,
      padding: 8,
    }}>
      <div>{data.label || data.id}</div>
      <button onClick={onClose}>Close</button>
    </div>
  )}
/>
```

## Notes

- `contextMenu` renders on right-click of any node or edge
- The `RadialMenu` renders as an HTML overlay positioned at the click point
- `onClose` must be called to dismiss the menu
- Collapse props (`canCollapse`, `isCollapsed`, `onCollapse`) are available for node hierarchies
