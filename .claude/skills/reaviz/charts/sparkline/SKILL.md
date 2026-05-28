# Sparkline

Compact inline charts for embedding in dashboards and metric displays. Four variants: line, area, bar, and sonar (diverging stacked bar). All hide axes, gridlines, and labels by default for a minimal appearance.

## Import

```tsx
import {
  SparklineChart,
  AreaSparklineChart,
  BarSparklineChart,
  SonarChart
} from 'reaviz';
```

## SparklineChart (Line)

Line sparkline with smooth interpolation, hover points, and no area fill.

### Props

Extends LineChart/AreaChart props with sparkline defaults.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | — | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `series` | `ReactElement<AreaSeriesProps>` | line-only, smooth, strokeWidth 2 | Series component |
| `xAxis` | `ReactElement` | hidden, type `time`, scaled | X axis |
| `yAxis` | `ReactElement` | hidden, type `value`, scaled | Y axis |
| `gridlines` | `ReactElement \| null` | `null` | Gridlines (hidden) |

### Usage

```tsx
<SparklineChart
  width={200}
  height={55}
  data={data}
/>
```

## AreaSparklineChart

Area sparkline with striped mask, gradient fill, and smooth interpolation.

### Props

Same as SparklineChart. Default series includes:
- Striped mask pattern
- Gradient from transparent (10%) to opaque (80%)
- Line strokeWidth of 3
- Hover points

### Usage

```tsx
<AreaSparklineChart
  width={200}
  height={85}
  data={data}
/>
```

## BarSparklineChart

Bar sparkline with single color scheme.

### Props

Extends BarChart props with sparkline defaults.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | — | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `series` | `ReactElement<BarSeriesProps>` | single cybertron color | Series component |
| `xAxis` | `ReactElement` | hidden, type `category` | X axis |
| `yAxis` | `ReactElement` | hidden, type `value` | Y axis |
| `gridlines` | `ReactElement \| null` | `null` | Gridlines (hidden) |

### Usage

```tsx
<BarSparklineChart
  width={200}
  height={35}
  data={data}
/>
```

## SonarChart

Stacked diverging bar chart for signal/activity visualization. Bars extend both up and down from center.

### Props

Extends BarChart props. Uses `ChartNestedDataShape[]` data.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartNestedDataShape[]` | — | Nested data (two values per entry) |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `0` | Chart margins |
| `series` | `ReactElement` | stackedDiverging with gradient bars | Series component |
| `xAxis` | `ReactElement` | hidden, type `category` | X axis |
| `yAxis` | `ReactElement` | hidden, type `value` | Y axis |
| `gridlines` | `ReactElement \| null` | `null` | Gridlines (hidden) |

### Usage

```tsx
const sonarData = [
  { key: 'T1', data: [
    { key: 'up', data: 5 },
    { key: 'down', data: 3 },
  ]},
  { key: 'T2', data: [
    { key: 'up', data: 8 },
    { key: 'down', data: 2 },
  ]},
];

<SonarChart
  width={300}
  height={50}
  data={sonarData}
/>
```

## Common Data Shape

All sparkline variants (except SonarChart) use flat data:

```tsx
const data = [
  { key: new Date('2024-01-01'), data: 10 },
  { key: new Date('2024-02-01'), data: 25 },
  { key: new Date('2024-03-01'), data: 18 },
];
```

## Customization

All variants accept their parent chart's props, so you can override defaults:

```tsx
// Custom line color
import { LineSeries, Line } from 'reaviz';

<SparklineChart
  width={200}
  height={55}
  data={data}
  series={
    <LineSeries
      interpolation="linear"
      line={<Line strokeWidth={1} />}
      colorScheme="#FF5722"
    />
  }
/>
```

## Notes

- All variants hide axes, gridlines, tick marks, and labels by default
- SparklineChart and AreaSparklineChart use `scaled={true}` on axes for tight data fitting
- SparklineChart shows points on hover; set `symbols={null}` to disable
- AreaSparklineChart uses a `Stripes` mask over a gradient fill
- SonarChart uses `type="stackedDiverging"` with two gradient bars and absolute-value tooltips
- Designed for small dimensions — typical heights are 35-85px
