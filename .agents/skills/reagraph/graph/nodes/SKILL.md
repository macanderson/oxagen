# Nodes

Node rendering components and custom node support. Default nodes are 3D spheres; variants add icons, SVGs, and badges. Use `renderNode` for fully custom rendering.

## Import

```tsx
import {
  Sphere,
  SphereWithIcon,
  SphereWithSvg,
  Svg,
  Badge
} from 'reagraph';
```

## Built-in Node Types

### Sphere (Default)

Basic 3D sphere. This is what renders when no `renderNode` is provided.

### SphereWithIcon

Sphere with an image/icon overlay.

| Prop | Type | Description |
|------|------|-------------|
| `image` | `string` | Image URL (required) |

### SphereWithSvg

Sphere with an SVG overlay.

| Prop | Type | Description |
|------|------|-------------|
| `image` | `string` | SVG URL (required) |
| `svgFill` | `ColorRepresentation` | Override SVG fill color |

### Svg

Standalone SVG node (no sphere).

| Prop | Type | Description |
|------|------|-------------|
| `image` | `string` | SVG URL (required) |

### Badge

Overlay badge for displaying counts or status on a node.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `label` | `string` | — | Badge text (required) |
| `backgroundColor` | `string` | `'#ffffff'` | Background color |
| `textColor` | `string` | `'#000000'` | Text color |
| `strokeColor` | `string` | — | Border color |
| `strokeWidth` | `number` | `0` | Border thickness |
| `radius` | `number` | `0.12` | Corner radius |
| `badgeSize` | `number` | `1.5` | Size multiplier relative to node |
| `position` | `BadgePosition \| [x, y, z]` | `'top-right'` | Placement |
| `padding` | `number` | `0.15` | Text padding |
| `fontSize` | `number` | `0.3` | Font size |
| `fontWeight` | `number` | — | Font weight (100-900) |
| `icon` | `string` | — | SVG icon path or URL |
| `iconSize` | `number` | `0.35` | Icon size |
| `iconPosition` | `'start' \| 'end' \| [x, y]` | `'start'` | Icon placement |
| `iconTextGap` | `number` | `0.01` | Gap between icon and text |
| `opacity` | `number` | `1` | Badge opacity |

**BadgePosition**: `'top-right'` | `'top-left'` | `'bottom-right'` | `'bottom-left'` | `'center'`

## NodeRenderer Props

All built-in node types receive:

| Prop | Type | Description |
|------|------|-------------|
| `id` | `string` | Node ID |
| `node` | `InternalGraphNode` | Full node data |
| `color` | `ColorRepresentation` | Resolved color (handles active/selected) |
| `size` | `number` | Resolved size |
| `active` | `boolean` | Whether node is active |
| `selected` | `boolean` | Whether node is selected |
| `opacity` | `number` | Resolved opacity |
| `animated` | `boolean` | Whether animations are enabled |

## Custom Node Renderer

```tsx
import { GraphCanvas, NodeRendererProps, Sphere, Badge } from 'reagraph';

const renderNode = ({ node, ...rest }: NodeRendererProps) => (
  <group>
    <Sphere {...rest} node={node} />
    {node.data?.count > 0 && (
      <Badge
        {...rest}
        node={node}
        label={String(node.data.count)}
        position="top-right"
        backgroundColor="#ff5722"
        textColor="#fff"
      />
    )}
  </group>
);

<GraphCanvas
  nodes={nodes}
  edges={edges}
  renderNode={renderNode}
/>
```

## Per-Node Styling

Override theme defaults per node via data:

```tsx
const nodes = [
  { id: '1', label: 'Normal', fill: '#7CA0AB' },
  { id: '2', label: 'Alert', fill: '#FF5722', size: 12 },
  { id: '3', label: 'With Icon', icon: '/server.svg' },
];
```

## Node with Icon

```tsx
const renderNode = ({ node, ...rest }: NodeRendererProps) => (
  <SphereWithIcon {...rest} node={node} image={node.icon} />
);

<GraphCanvas nodes={nodes} edges={edges} renderNode={renderNode} />
```

## Notes

- Default node type is `Sphere` (no `renderNode` needed)
- `renderNode` receives Three.js context — return `<group>`, `<mesh>`, or reagraph symbol components
- Node `fill` in data overrides `theme.node.fill`
- Node `size` in data overrides the sizing strategy result
- Badge is an overlay — render it alongside a Sphere in a `<group>`
