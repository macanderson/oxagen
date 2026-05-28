# Markers

Reference lines and hover indicators for highlighting specific values on charts. `LinearValueMarker` for cartesian charts, `RadialValueMarker` for radial charts, `MarkLine` for hover crosshairs.

## Import

```tsx
import { LinearValueMarker, RadialValueMarker, MarkLine } from 'reaviz';
```

## LinearValueMarker Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `any` | — | Value to mark on the axis (required) |
| `color` | `string` | — | Line color (required) |
| `thickness` | `number` | `1` | Line thickness |
| `size` | `number` | — | Custom line size |
| `direction` | `'horizontal' \| 'vertical'` | `'horizontal'` | Line direction |
| `className` | `string` | — | CSS class |

## RadialValueMarker Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `number` | — | Value to mark (required) |
| `color` | `string` | — | Line color (required) |
| `thickness` | `number` | `1` | Line thickness |
| `className` | `string` | — | CSS class |

## MarkLine Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `strokeColor` | `string` | `'#eee'` | Line color |
| `strokeWidth` | `number` | `1` | Line thickness |

## Value Markers on Area/Line Charts

```tsx
<AreaChart
  data={data}
  series={
    <AreaSeries
      valueMarkers={[
        <LinearValueMarker value={50} color="#D740BE" />,
        <LinearValueMarker value={25} color="#F8A340" />,
      ]}
    />
  }
/>
```

## Thick Reference Line

```tsx
<LinearValueMarker value={100} color="red" thickness={3} />
```

## Vertical Reference Line

```tsx
<LinearValueMarker
  value={new Date('2024-06-01')}
  color="#2196F3"
  direction="vertical"
/>
```

## Value Markers on Bar Charts

```tsx
<BarChart
  data={data}
  series={
    <BarSeries
      valueMarkers={[
        <LinearValueMarker value={50} color="#D740BE" />,
      ]}
    />
  }
/>
```

## Radial Value Marker

```tsx
<RadialAreaChart
  data={data}
  series={
    <RadialAreaSeries
      valueMarkers={[
        <RadialValueMarker value={75} color="#FF5722" />,
      ]}
    />
  }
/>
```

## Custom MarkLine (Hover Crosshair)

```tsx
// MarkLine is included by default in AreaSeries/LineSeries
// Customize or disable it:
<AreaSeries markLine={<MarkLine strokeColor="#fff" strokeWidth={2} />} />

// Remove hover crosshair
<AreaSeries markLine={null} />
```

## Notes

- Value markers render as horizontal or vertical lines at a specific data value
- Pass `valueMarkers` as an array to the series component (AreaSeries, BarSeries, LineSeries, etc.)
- `MarkLine` is the hover crosshair shown when mousing over area/line charts — included by default
- Linear markers support both numeric values and Date values (for time axes)
