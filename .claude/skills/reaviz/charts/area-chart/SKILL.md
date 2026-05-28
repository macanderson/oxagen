# AreaChart

Area chart with gradient fill, line, and data points. Supports single series, grouped multi-series, stacked, and stacked-normalized variants.

## Import

```tsx
import {
  AreaChart,
  AreaSeries,
  Area,
  Line,
  PointSeries,
  StackedAreaChart,
  StackedAreaSeries,
  StackedNormalizedAreaChart,
  StackedNormalizedAreaSeries
} from 'reaviz';
```

## AreaChart Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `series` | `ReactElement<AreaSeriesProps>` | `<AreaSeries />` | Series component |
| `xAxis` | `ReactElement<LinearAxisProps>` | `<LinearXAxis type="time" />` | X axis component |
| `yAxis` | `ReactElement<LinearAxisProps>` | `<LinearYAxis type="value" />` | Y axis component |
| `gridlines` | `ReactElement \| null` | `<GridlineSeries />` | Gridlines (`null` to hide) |
| `brush` | `ReactElement \| null` | `null` | Brush selection component |
| `zoomPan` | `ReactElement \| null` | `null` | Zoom/pan component |
| `secondaryAxis` | `ReactElement[]` | — | Additional axis components |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## AreaSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `'standard' \| 'grouped' \| 'stacked' \| 'stackedNormalized'` | `'standard'` | Chart type |
| `animated` | `boolean` | `true` | Enable animations |
| `interpolation` | `InterpolationTypes` | `'linear'` | Curve interpolation |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `area` | `ReactElement<AreaProps> \| null` | `<Area />` | Area fill component (`null` to hide) |
| `line` | `ReactElement<LineProps> \| null` | `<Line />` | Line component (`null` to hide) |
| `symbols` | `ReactElement<PointSeriesProps> \| null` | `<PointSeries />` | Data point symbols |
| `tooltip` | `ReactElement<TooltipAreaProps>` | `<TooltipArea />` | Tooltip component |
| `markLine` | `ReactElement<MarkLineProps> \| null` | `<MarkLine />` | Hover mark line |
| `valueMarkers` | `ReactElement<LinearValueMarkerProps>[] \| null` | — | Reference lines at specific values |

## Area Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `gradient` | `ReactElement<GradientProps> \| null` | `<Gradient />` | Area gradient fill |
| `mask` | `ReactElement<MaskProps> \| null` | — | SVG pattern mask |
| `glow` | `Glow` | — | Glow effect |

## Line Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `strokeWidth` | `number` | `3` | Line thickness |
| `showZeroStroke` | `boolean` | `true` | Show line when value is zero |
| `gradient` | `ReactElement<GradientProps> \| null` | — | Line gradient |
| `glow` | `Glow` | — | Glow effect |

## PointSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `show` | `boolean \| 'hover' \| 'first' \| 'last'` | `'hover'` | When to show data points |
| `point` | `ReactElement<ScatterPointProps>` | `<ScatterPoint />` | Point element to render |

## Basic Usage

### Single Series

```tsx
const data = [
  { key: new Date('2024-01-01'), data: 10 },
  { key: new Date('2024-02-01'), data: 25 },
  { key: new Date('2024-03-01'), data: 18 },
];

<AreaChart
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

<AreaChart
  width={550}
  height={350}
  data={data}
  series={<AreaSeries type="grouped" colorScheme="cybertron" />}
/>
```

### Stacked

```tsx
<StackedAreaChart
  width={550}
  height={350}
  data={multiSeriesData}
  series={<StackedAreaSeries colorScheme="cybertron" />}
/>
```

### Stacked Normalized (Percentage)

```tsx
<StackedNormalizedAreaChart
  width={550}
  height={350}
  data={multiSeriesData}
  series={<StackedNormalizedAreaSeries colorScheme="cybertron" />}
/>
```

## Customization

### Smooth Interpolation

```tsx
<AreaChart
  data={data}
  series={<AreaSeries interpolation="smooth" />}
/>
```

### Custom Gradient

```tsx
import { Area, Gradient, GradientStop } from 'reaviz';

<AreaChart
  data={data}
  series={
    <AreaSeries
      area={
        <Area
          gradient={
            <Gradient
              stops={[
                <GradientStop offset="0%" stopOpacity={0.2} />,
                <GradientStop offset="50%" stopOpacity={1} />,
              ]}
            />
          }
        />
      }
    />
  }
/>
```

### Pattern Mask

```tsx
import { Area, Stripes } from 'reaviz';

<AreaChart
  data={data}
  series={
    <AreaSeries area={<Area mask={<Stripes />} />} />
  }
/>
```

### Value Markers (Reference Lines)

```tsx
import { LinearValueMarker } from 'reaviz';

<AreaChart
  data={data}
  series={
    <AreaSeries
      type="grouped"
      valueMarkers={[
        <LinearValueMarker value={12} color="#D740BE" />,
        <LinearValueMarker value={6} color="#F8A340" />,
      ]}
    />
  }
/>
```

### Point Visibility

```tsx
// Always visible
<AreaSeries symbols={<PointSeries show={true} />} />

// Only on hover (default)
<AreaSeries symbols={<PointSeries show="hover" />} />

// First or last point only
<AreaSeries symbols={<PointSeries show="first" />} />
<AreaSeries symbols={<PointSeries show="last" />} />

// No points
<AreaSeries symbols={null} />
```

### Line Only (No Fill)

```tsx
<AreaSeries area={null} />
```

### Area Only (No Line)

```tsx
<AreaSeries line={null} />
```

### Custom Line Width

```tsx
<AreaSeries line={<Line strokeWidth={5} />} />
```

### Custom Colors

```tsx
// Function-based
<AreaSeries colorScheme={(_data, index) => index % 2 ? 'blue' : 'green'} />
```

### Secondary Axis

```tsx
<AreaChart
  data={data}
  secondaryAxis={[
    <LinearXAxis type="category" position="start" />,
  ]}
/>
```

### Axis Configuration

```tsx
import { LinearXAxis, LinearYAxis, LinearXAxisTickSeries, LinearYAxisTickSeries } from 'reaviz';

<AreaChart
  data={data}
  xAxis={
    <LinearXAxis
      type="time"
      tickSeries={<LinearXAxisTickSeries label={null} />}
    />
  }
  yAxis={
    <LinearYAxis
      type="value"
      tickSeries={<LinearYAxisTickSeries label={null} />}
    />
  }
/>
```

### No Gridlines

```tsx
<AreaChart data={data} gridlines={null} />
```

## Interpolation Types

| Value | Curve |
|-------|-------|
| `'linear'` | Straight line segments (default) |
| `'smooth'` | Cardinal spline |
| `'step'` | Step function |
| `'monotone'` | Monotone cubic |
| `'natural'` | Natural cubic spline |
| `'basis'` | B-spline |
| `'cardinal'` | Cardinal spline |

## Variant Components

| Component | Description |
|-----------|-------------|
| `AreaChart` | Base chart — single or multi-series via `type` prop on series |
| `StackedAreaChart` | Pre-configured for `type="stacked"` with nested data |
| `StackedNormalizedAreaChart` | Stacked to 100% with percentage Y-axis formatting |
| `AreaSeries` | Default series component |
| `StackedAreaSeries` | Series pre-set to `type="stacked"` |
| `StackedNormalizedAreaSeries` | Series pre-set to `type="stackedNormalized"` with percentage tooltips |
