# Brush & ZoomPan

Interactive range selection and zoom/pan for charts. Brush allows selecting a data range; ZoomPan enables zooming and panning the view.

## Import

```tsx
import { ChartBrush, ChartZoomPan } from 'reaviz';
```

## ChartBrush Props

Most props are set internally by the parent chart. User-configurable:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `disabled` | `boolean` | — | Disable brush |
| `fill` | `string` | — | Brush selection fill color |
| `domain` | `[ChartDataTypes, ChartDataTypes]` | — | Initial brush domain |
| `onBrushChange` | `(event: BrushChangeEvent) => void` | — | Callback when brush range changes |

### BrushChangeEvent

```ts
interface BrushChangeEvent {
  start?: number;
  end?: number;
}
```

## ChartZoomPan Props

Most props are set internally by the parent chart. User-configurable:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `disabled` | `boolean` | — | Disable zoom/pan |
| `pannable` | `boolean` | `true` | Enable panning |
| `zoomable` | `boolean` | `true` | Enable zooming |
| `maxZoom` | `number` | `10` | Maximum zoom level |
| `zoomStep` | `number` | `0.1` | Zoom increment per scroll |
| `disableMouseWheel` | `boolean` | — | Disable scroll-to-zoom |
| `requireZoomModifier` | `boolean` | — | Require modifier key (Ctrl/Cmd) to zoom |
| `domain` | `[ChartDataTypes, ChartDataTypes]` | — | Controlled zoom domain |
| `onZoomPan` | `(event: ZoomPanChangeEvent) => void` | — | Callback on zoom/pan |

### ZoomPanChangeEvent

```ts
interface ZoomPanChangeEvent {
  domain: [ChartDataTypes, ChartDataTypes];
  isZoomed: boolean;
}
```

## Adding Brush to a Chart

```tsx
<AreaChart
  data={data}
  brush={<ChartBrush />}
/>
```

## Brush with Callback

```tsx
<AreaChart
  data={data}
  brush={
    <ChartBrush
      onBrushChange={(e) => console.log('Range:', e.start, e.end)}
    />
  }
/>
```

## Adding ZoomPan to a Chart

```tsx
<AreaChart
  data={data}
  zoomPan={<ChartZoomPan />}
/>
```

## ZoomPan with Controlled Domain

```tsx
const [domain, setDomain] = useState<[Date, Date]>();

<AreaChart
  data={data}
  zoomPan={
    <ChartZoomPan
      domain={domain}
      onZoomPan={(e) => setDomain(e.domain)}
    />
  }
/>
```

## Require Modifier Key for Zoom

```tsx
<ChartZoomPan requireZoomModifier />
```

## Disable Mouse Wheel Zoom

```tsx
<ChartZoomPan disableMouseWheel />
```

## Pan Only (No Zoom)

```tsx
<ChartZoomPan zoomable={false} pannable />
```

## Notes

- Pass `brush` or `zoomPan` as a chart prop — they are `null` by default
- Brush renders a draggable selection overlay at the bottom of the chart
- ZoomPan changes the chart's visible domain without modifying data
- Both components fire callbacks with the new data range for controlled usage
- Brush and ZoomPan are supported on AreaChart, LineChart, and ScatterPlot
