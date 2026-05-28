# Clusters

Group nodes into visual clusters by a shared attribute. Clusters render as rings around grouped nodes with optional labels and custom rendering.

## Configuration

Set `clusterAttribute` on `GraphCanvas` to enable clustering. The value should match a property on your `GraphNode` objects.

## GraphCanvas Cluster Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `clusterAttribute` | `string` | — | Node property to cluster by |
| `constrainDragging` | `boolean` | `false` | Constrain node dragging to cluster bounds |
| `onRenderCluster` | `ClusterRenderer` | — | Custom cluster render function |
| `onClusterClick` | `(cluster, event) => void` | — | Cluster click handler |
| `onClusterPointerOver` | `(cluster, event) => void` | — | Pointer enters cluster |
| `onClusterPointerOut` | `(cluster, event) => void` | — | Pointer leaves cluster |
| `onClusterDragged` | `(cluster) => void` | — | Cluster drag completed |

## ClusterRenderer Props

```ts
interface ClusterRendererProps {
  outerRadius: number;
  innerRadius: number;
  padding: number;
  opacity: number;
  label: ClusterLabel;
  theme: Theme;
}
```

## Basic Clustering

```tsx
const nodes = [
  { id: '1', label: 'Web Server', cluster: 'frontend' },
  { id: '2', label: 'API Server', cluster: 'backend' },
  { id: '3', label: 'Database', cluster: 'backend' },
  { id: '4', label: 'CDN', cluster: 'frontend' },
];

<GraphCanvas
  nodes={nodes}
  edges={edges}
  clusterAttribute="cluster"
/>
```

## Cluster Events

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  clusterAttribute="cluster"
  onClusterClick={(cluster, event) => console.log(cluster)}
/>
```

## Custom Cluster Renderer

```tsx
import { GraphCanvas, ClusterRendererProps } from 'reagraph';

const renderCluster = ({ outerRadius, label, theme }: ClusterRendererProps) => (
  <mesh>
    <ringGeometry args={[outerRadius - 2, outerRadius, 32]} />
    <meshBasicMaterial color="#4CAF50" opacity={0.3} transparent />
  </mesh>
);

<GraphCanvas
  nodes={nodes}
  edges={edges}
  clusterAttribute="cluster"
  onRenderCluster={renderCluster}
/>
```

## Cluster Theme Styling

```tsx
const customTheme = {
  ...lightTheme,
  cluster: {
    stroke: '#D8E6EA',
    fill: '#f0f0f0',
    opacity: 1,
    selectedOpacity: 1,
    inactiveOpacity: 0.1,
    label: {
      color: '#2A6475',
      stroke: '#fff',
    },
  },
};
```

## Notes

- Clusters are automatically computed from the `clusterAttribute` value on each node
- Nodes without the attribute are not clustered
- Cluster-aware layouts (e.g. `forceDirected2d`) group nodes spatially
- `constrainDragging` keeps dragged nodes within their cluster boundary
- Default cluster rendering is a ring with a label; use `onRenderCluster` to customize
