# Sizing

Node sizing strategies that automatically compute node sizes based on graph metrics or custom attributes.

## Configuration

Set `sizingType` on `GraphCanvas`:

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  sizingType="pagerank"
  minNodeSize={5}
  maxNodeSize={20}
/>
```

## SizingType

| Type | Description |
|------|-------------|
| `'default'` | Use node's own `size` property (default) |
| `'none'` | All nodes use `defaultNodeSize` |
| `'pagerank'` | Size by PageRank score |
| `'centrality'` | Size by degree centrality |
| `'attribute'` | Size by a custom node attribute |

## GraphCanvas Sizing Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `sizingType` | `SizingType` | `'default'` | Sizing strategy |
| `defaultNodeSize` | `number` | `7` | Default node size |
| `minNodeSize` | `number` | `5` | Min size for auto-sizing |
| `maxNodeSize` | `number` | `15` | Max size for auto-sizing |
| `sizingAttribute` | `string` | — | Attribute name for `'attribute'` sizing |

## Default Sizing

Uses each node's `size` property, falls back to `defaultNodeSize`:

```tsx
const nodes = [
  { id: '1', label: 'Small', size: 5 },
  { id: '2', label: 'Large', size: 15 },
  { id: '3', label: 'Default' }, // uses defaultNodeSize
];

<GraphCanvas nodes={nodes} edges={edges} sizingType="default" />
```

## PageRank Sizing

Nodes with more important connections appear larger:

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  sizingType="pagerank"
  minNodeSize={3}
  maxNodeSize={25}
/>
```

## Centrality Sizing

Nodes with more connections appear larger:

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  sizingType="centrality"
/>
```

## Attribute Sizing

Size nodes by a custom data attribute:

```tsx
const nodes = [
  { id: '1', label: 'Low', data: { severity: 2 } },
  { id: '2', label: 'Medium', data: { severity: 5 } },
  { id: '3', label: 'High', data: { severity: 9 } },
];

<GraphCanvas
  nodes={nodes}
  edges={edges}
  sizingType="attribute"
  sizingAttribute="severity"
  minNodeSize={5}
  maxNodeSize={20}
/>
```

## Uniform Sizing

All nodes the same size:

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  sizingType="none"
  defaultNodeSize={10}
/>
```

## Notes

- `minNodeSize` and `maxNodeSize` bound the auto-computed sizes for `pagerank`, `centrality`, and `attribute`
- PageRank formula: `rank * 80`, then clamped to min/max
- Centrality formula: `rank * 20`, then clamped to min/max
- `'attribute'` requires `sizingAttribute` to specify which node property to use
- Per-node `size` in data always takes precedence when `sizingType="default"`
