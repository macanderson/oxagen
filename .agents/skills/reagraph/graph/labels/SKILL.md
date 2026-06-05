# Labels

Label visibility, styling, and font configuration for nodes and edges. Labels auto-show/hide based on zoom level or can be forced visible.

## Import

```tsx
import { GraphCanvas } from 'reagraph';
// LabelVisibilityType is used as a prop value, not imported directly
```

## LabelVisibilityType

Controls which labels are visible. Set via `labelType` on `GraphCanvas`:

| Value | Description |
|-------|-------------|
| `'auto'` | Show labels based on zoom level and node size (default) |
| `'all'` | Always show all labels |
| `'none'` | Hide all labels |
| `'nodes'` | Show only node labels |
| `'edges'` | Show only edge labels |

## EdgeLabelPosition

Controls where edge labels appear. Set via `edgeLabelPosition` on `GraphCanvas`:

| Value | Description |
|-------|-------------|
| `'inline'` | On the edge line (default) |
| `'above'` | Above the edge |
| `'below'` | Below the edge |
| `'natural'` | Natural position along edge |

## Label Props (Internal)

These apply to the internal `Label` component used by nodes and edges:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fontSize` | `number` | `7` | Font size |
| `fontUrl` | `string` | Google Roboto | Font file URL (.ttf/.otf/.woff) |
| `color` | `ColorRepresentation` | `'#2A6475'` | Text color |
| `stroke` | `ColorRepresentation` | — | Text stroke color |
| `backgroundColor` | `ColorRepresentation` | — | Label background color |
| `backgroundOpacity` | `number` | `1` | Background opacity |
| `padding` | `number` | `1` | Background padding |
| `strokeColor` | `ColorRepresentation` | — | Background border color |
| `strokeWidth` | `number` | `0` | Background border width |
| `radius` | `number` | `0.1` | Background corner radius |
| `opacity` | `number` | `1` | Label opacity |
| `ellipsis` | `number` | `75` | Max characters before ellipsis |

## Auto-Visibility (Default)

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  labelType="auto"
/>
```

Labels appear as you zoom in, disappear when zoomed out. Larger nodes show labels at greater distances.

## Always Show Labels

```tsx
<GraphCanvas nodes={nodes} edges={edges} labelType="all" />
```

## Force Per-Node Label Visibility

```tsx
const nodes = [
  { id: '1', label: 'Always Visible', labelVisible: true },
  { id: '2', label: 'Auto Managed' },
  { id: '3', label: 'Always Hidden', labelVisible: false },
];
```

## Custom Font

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  labelFontUrl="/fonts/Inter-Regular.woff"
/>
```

## Node Labels and SubLabels

```tsx
const nodes = [
  { id: '1', label: 'Server', subLabel: '192.168.1.1' },
  { id: '2', label: 'Database', subLabel: 'PostgreSQL' },
];
```

## Edge Labels

```tsx
const edges = [
  { id: 'e1', source: '1', target: '2', label: 'HTTP', subLabel: '443' },
];

<GraphCanvas
  edges={edges}
  edgeLabelPosition="above"
/>
```

## Label Styling via Theme

```tsx
const customTheme = {
  ...lightTheme,
  node: {
    ...lightTheme.node,
    label: {
      color: '#333',
      stroke: '#fff',
      activeColor: '#1DE9AC',
      backgroundColor: 'rgba(255,255,255,0.8)',
      padding: 2,
      radius: 0.2,
    },
  },
};

<GraphCanvas nodes={nodes} edges={edges} theme={customTheme} />
```

## Notes

- `labelType="auto"` uses zoom distance and node size to compute visibility
- Per-node `labelVisible: true/false` overrides the global `labelType`
- Edge labels use `theme.edge.label` for styling
- Labels are rendered with SDF (Signed Distance Field) text via `@react-three/drei`
- Default font is Google Roboto; provide `labelFontUrl` for custom fonts
