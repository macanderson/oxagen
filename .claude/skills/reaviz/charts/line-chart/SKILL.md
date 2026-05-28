# LineChart

Line chart built on top of AreaChart with the area fill removed. Supports single series, grouped multi-series, and all AreaChart features (interpolation, points, markers, brush, zoom).

## Import

```tsx
import { LineChart, LineSeries } from 'reaviz';
```

## LineChart Props

Same as AreaChart — LineChart is an AreaChart with `<LineSeries />` as the default series.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `series` | `ReactElement<LineSeriesProps>` | `<LineSeries />` | Series component |
| `xAxis` | `ReactElement<LinearAxisProps>` | `<LinearXAxis type="time" />` | X axis component |
| `yAxis` | `ReactElement<LinearAxisProps>` | `<LinearYAxis type="value" />` | Y axis component |
| `gridlines` | `ReactElement \| null` | `<GridlineSeries />` | Gridlines (`null` to hide) |
| `brush` | `ReactElement \| null` | `null` | Brush selection component |
| `zoomPan` | `ReactElement \| null` | `null` | Zoom/pan component |
| `secondaryAxis` | `ReactElement[]` | — | Additional axis components |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## LineSeries Props

Same as AreaSeries — LineSeries is an AreaSeries with `area={null}` and `line={<Line strokeWidth={3} />}`.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `'standard' \| 'grouped' \| 'stacked' \| 'stackedNormalized'` | `'standard'` | Chart type |
| `animated` | `boolean` | `true` | Enable animations |
| `interpolation` | `InterpolationTypes` | `'linear'` | Curve interpolation |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `line` | `ReactElement<LineProps> \| null` | `<Line strokeWidth={3} />` | Line component |
| `area` | `ReactElement<AreaProps> \| null` | `null` | Area fill (null by default) |
| `symbols` | `ReactElement<PointSeriesProps> \| null` | `<PointSeries />` | Data point symbols |
| `tooltip` | `ReactElement<TooltipAreaProps>` | `<TooltipArea />` | Tooltip component |
| `markLine` | `ReactElement<MarkLineProps> \| null` | `<MarkLine />` | Hover mark line |
| `valueMarkers` | `ReactElement<LinearValueMarkerProps>[] \| null` | — | Reference lines at specific values |

## Basic Usage

### Single Series

```tsx
const data = [
  { key: new Date('2024-01-01'), data: 10 },
  { key: new Date('2024-02-01'), data: 25 },
  { key: new Date('2024-03-01'), data: 18 },
];

<LineChart
  width={350}
  height={250}
  data={data}
/>
```

### Multi-Series (Grouped)

```tsx
const data = [
  { key: new Date('2024-01-01'), data: [
    { key: 'Series A', data: 10 },
    { key: 'Series B', data: 15 },
  ]},
  { key: new Date('2024-02-01'), data: [
    { key: 'Series A', data: 25 },
    { key: 'Series B', data: 20 },
  ]},
];

<LineChart
  width={550}
  height={250}
  data={data}
  series={<LineSeries type="grouped" colorScheme="cybertron" />}
/>
```

## Customization

### Custom Stroke Width

```tsx
import { Line } from 'reaviz';

<LineChart
  data={data}
  series={<LineSeries line={<Line strokeWidth={4} />} />}
/>
```

### Smooth Interpolation

```tsx
<LineChart
  data={data}
  series={<LineSeries interpolation="smooth" />}
/>
```

### Always Show Points

```tsx
import { PointSeries } from 'reaviz';

<LineChart
  data={data}
  series={<LineSeries symbols={<PointSeries show={true} />} />}
/>
```

### Point Visibility Options

```tsx
// Show on hover (default)
<LineSeries symbols={<PointSeries show="hover" />} />

// Show first point only
<LineSeries symbols={<PointSeries show="first" />} />

// Show last point only
<LineSeries symbols={<PointSeries show="last" />} />

// No points
<LineSeries symbols={null} />
```

### Value Markers (Reference Lines)

```tsx
import { LinearValueMarker } from 'reaviz';

<LineChart
  data={data}
  series={
    <LineSeries
      type="grouped"
      colorScheme="cybertron"
      valueMarkers={[
        <LinearValueMarker value={12} color="#D740BE" />,
        <LinearValueMarker value={6} color="#F8A340" />,
      ]}
    />
  }
/>
```

### Custom Gridlines

```tsx
import { GridlineSeries, Gridline } from 'reaviz';

<LineChart
  data={data}
  gridlines={<GridlineSeries line={<Gridline direction="all" />} />}
/>
```

### Line with Gradient

```tsx
import { Line, Gradient } from 'reaviz';

<LineChart
  data={data}
  series={
    <LineSeries line={<Line gradient={<Gradient />} />} />
  }
/>
```

### Line with Glow

```tsx
<LineChart
  data={data}
  series={
    <LineSeries
      line={<Line glow={{ color: '#2196F3', blur: 10 }} />}
    />
  }
/>
```

### No Gridlines

```tsx
<LineChart data={data} gridlines={null} />
```

## Notes

- LineChart is a thin wrapper around AreaChart — it sets `area={null}` and a default `strokeWidth={3}` line
- All AreaChart features work: brush, zoom/pan, secondary axes, stacked types
- For an area + line combo, use AreaChart directly instead of LineChart
- Interpolation types: `'linear'` | `'smooth'` | `'step'` | `'monotone'` | `'natural'` | `'basis'` | `'cardinal'`
