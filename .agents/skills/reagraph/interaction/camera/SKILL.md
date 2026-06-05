# Camera

Camera control, modes, centering, and viewport manipulation.

## Import

```tsx
import { GraphCanvas, useCameraControls, useCenterGraph } from 'reagraph';
```

## CameraMode

Set via `cameraMode` on `GraphCanvas`:

| Mode | Description |
|------|-------------|
| `'pan'` | Pan and zoom (default, best for 2D) |
| `'rotate'` | Rotate and zoom |
| `'orbit'` | Full orbit control (best for 3D) |
| `'orthographic'` | Orthographic projection with pan/zoom |

## GraphCanvas Camera Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `cameraMode` | `CameraMode` | `'pan'` | Camera interaction mode |
| `maxDistance` | `number` | `50000` | Max camera distance (perspective) |
| `minDistance` | `number` | `1000` | Min camera distance (perspective) |
| `minZoom` | `number` | `1` | Min zoom level (orthographic) |
| `maxZoom` | `number` | `100` | Max zoom level (orthographic) |

## useCameraControls Hook

Access camera controls imperatively from inside the Three.js context:

```tsx
const {
  controls,
  resetControls,
  zoomIn,
  zoomOut,
  dollyIn,
  dollyOut,
  panLeft,
  panRight,
  panUp,
  panDown,
  freeze,
  unFreeze,
} = useCameraControls();
```

| Method | Description |
|--------|-------------|
| `resetControls(animated?)` | Reset camera to initial state |
| `zoomIn()` / `zoomOut()` | Zoom camera |
| `dollyIn(distance?)` / `dollyOut(distance?)` | Move camera closer/further (default: 1000) |
| `panLeft(delta?)` / `panRight(delta?)` | Pan horizontally (default: 100) |
| `panUp(delta?)` / `panDown(delta?)` | Pan vertically (default: 100) |
| `freeze()` / `unFreeze()` | Freeze/unfreeze camera controls |

## useCenterGraph Hook

Center or fit nodes into the viewport:

```tsx
const {
  centerNodes,
  centerNodesById,
  fitNodesInViewById,
  isCentered,
} = useCenterGraph({ animated: true, layoutType });
```

| Method | Description |
|--------|-------------|
| `centerNodes(nodes, opts?)` | Center on node objects |
| `centerNodesById(ids, opts?)` | Center on node IDs |
| `fitNodesInViewById(ids, opts?)` | Fit nodes into viewport |

### Options

```ts
interface CenterNodesParams {
  animated?: boolean;
  centerOnlyIfNodesNotInView?: boolean;
}

interface FitNodesParams {
  animated?: boolean;
  fitOnlyIfNodesNotInView?: boolean;
}
```

## Using Ref (Outside Three.js Context)

For camera control outside the canvas, use the `GraphCanvasRef`:

```tsx
const ref = useRef<GraphCanvasRef>(null);

<GraphCanvas ref={ref} nodes={nodes} edges={edges} />

<button onClick={() => ref.current?.centerGraph()}>Center</button>
<button onClick={() => ref.current?.zoomIn()}>Zoom In</button>
<button onClick={() => ref.current?.fitNodesInView(['1', '2'])}>Fit Nodes</button>
```

## 2D Mode

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  cameraMode="pan"
  layoutType="forceDirected2d"
/>
```

## 3D Mode

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  cameraMode="orbit"
  layoutType="forceDirected3d"
/>
```

## Orthographic Mode

```tsx
<GraphCanvas
  nodes={nodes}
  edges={edges}
  cameraMode="orthographic"
  minZoom={0.5}
  maxZoom={50}
/>
```

## Notes

- `useCameraControls` and `useCenterGraph` must be used inside the Three.js context (child of `GraphCanvas`)
- For external control, use the `GraphCanvasRef` methods instead
- `cameraMode="orbit"` is recommended for 3D layouts
- `cameraMode="pan"` is recommended for 2D layouts
