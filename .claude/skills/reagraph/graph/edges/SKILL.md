# Edges

Edge rendering configuration: arrows, dashed lines, curved paths, self-loops, labels, and edge aggregation.

## Edge Configuration

Edges are configured via `GraphEdge` data properties and `GraphCanvas` props — there is no separate edge component to import for typical use.

## GraphEdge Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `id` | `string` | — | Unique ID (required) |
| `source` | `string` | — | Source node ID (required) |
| `target` | `string` | — | Target node ID (required) |
| `label` | `string` | — | Edge label text |
| `subLabel` | `string` | — | Secondary label |
| `size` | `number` | — | Edge thickness |
| `fill` | `string` | — | Override edge color |
| `dashed` | `boolean` | `false` | Dashed line style |
| `dashArray` | `[number, number]` | `[3, 1]` | Dash pattern `[dashSize, gapSize]` |
| `interpolation` | `'linear' \| 'curved'` | `'linear'` | Edge shape |
| `arrowPlacement` | `'none' \| 'mid' \| 'end'` | `'end'` | Arrow position |
| `labelVisible` | `boolean` | — | Force label visibility |
| `subLabelPlacement` | `'below' \| 'above'` | `'below'` | SubLabel position |

## GraphCanvas Edge Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `edgeInterpolation` | `'linear' \| 'curved'` | `'linear'` | Default edge shape for all edges |
| `edgeArrowPosition` | `'none' \| 'mid' \| 'end'` | — | Default arrow placement |
| `edgeLabelPosition` | `'below' \| 'above' \| 'inline' \| 'natural'` | — | Default edge label position |
| `aggregateEdges` | `boolean` | `false` | Merge parallel edges |

## Basic Edges

```tsx
const edges = [
  { id: 'e1', source: '1', target: '2', label: 'connects' },
  { id: 'e2', source: '2', target: '3' },
];

<GraphCanvas nodes={nodes} edges={edges} />
```

## Arrows

```tsx
// Per-edge
const edges = [
  { id: 'e1', source: '1', target: '2', arrowPlacement: 'end' },
  { id: 'e2', source: '2', target: '3', arrowPlacement: 'mid' },
  { id: 'e3', source: '3', target: '1', arrowPlacement: 'none' },
];

// Global default
<GraphCanvas edges={edges} edgeArrowPosition="end" />
```

## Curved Edges

```tsx
// Per-edge
const edges = [
  { id: 'e1', source: '1', target: '2', interpolation: 'curved' },
];

// Global default
<GraphCanvas edges={edges} edgeInterpolation="curved" />
```

## Dashed Edges

```tsx
const edges = [
  { id: 'e1', source: '1', target: '2', dashed: true },
  { id: 'e2', source: '2', target: '3', dashed: true, dashArray: [5, 3] },
];
```

## Self-Loops

Edges where `source === target` automatically render as loops:

```tsx
const edges = [
  { id: 'e1', source: '1', target: '1', label: 'self-reference' },
];
```

## Edge Aggregation

Merge multiple edges between the same pair of nodes:

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  aggregateEdges
/>
```

## Per-Edge Color

```tsx
const edges = [
  { id: 'e1', source: '1', target: '2', fill: '#FF5722' },
  { id: 'e2', source: '2', target: '3', fill: '#4CAF50' },
];
```

## Edge Label Placement

```tsx
<GraphCanvas
  edges={edges}
  edgeLabelPosition="above"
/>
```

## Edge Events

```tsx
<GraphCanvas
  edges={edges}
  onEdgeClick={(edge, event) => console.log('Clicked:', edge.id)}
  onEdgePointerOver={(edge) => console.log('Hover:', edge.id)}
  onEdgePointerOut={(edge) => console.log('Left:', edge.id)}
  onEdgeContextMenu={(edge) => console.log('Right-click:', edge?.id)}
/>
```

## Notes

- Edge `fill` overrides `theme.edge.fill` per-edge
- Per-edge `interpolation` and `arrowPlacement` override the global `edgeInterpolation` / `edgeArrowPosition`
- Self-loops are detected automatically when `source === target`
- `aggregateEdges` combines edges with the same source/target pair into a single visual edge
