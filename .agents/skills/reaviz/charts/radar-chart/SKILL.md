# RadarChart

Radar (spider) chart built on top of RadialAreaChart. Displays multi-category data as a closed polygon with points on radial axes. Supports grouped multi-series, filled areas with gradients, and configurable radial axes.

## Import

```tsx
import {
  RadarChart,
  RadarChartSeries,
  RadialArea,
  RadialLine,
  RadialPointSeries,
  RadialAxis,
  RadialAxisArcSeries,
  RadialAxisTickSeries,
  RadialAxisArcLine
} from 'reaviz';
```

## RadarChart Props

Extends RadialAreaChart props.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartNestedDataShape[]` | `[]` | Chart data (nested multi-series) |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `75` | Chart margins |
| `innerRadius` | `number` | `0.1` | Inner radius ratio |
| `series` | `ReactElement<RadarChartSeriesProps>` | `<RadarChartSeries />` | Series component |
| `axis` | `ReactElement<RadialAxisProps> \| null` | `<RadialAxis />` | Radial axis component |
| `startAngle` | `number` | `0` | Start angle in radians |
| `endAngle` | `number` | `Math.PI * 2` | End angle in radians |
| `isClosedCurve` | `boolean` | `true` | Close the polygon curve |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## RadarChartSeries Props

Extends RadialAreaSeries props with radar-specific defaults.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `'standard' \| 'grouped'` | `'grouped'` | Series type |
| `animated` | `boolean` | `true` | Enable animations |
| `interpolation` | `'linear' \| 'smooth'` | `'smooth'` | Curve interpolation |
| `colorScheme` | `ColorSchemeType` | `schemes.cybertron` | Color scheme |
| `area` | `ReactElement<RadialAreaProps> \| null` | `null` | Area fill (disabled by default) |
| `line` | `ReactElement<RadialLineProps> \| null` | `<RadialLine />` | Line component |
| `symbols` | `ReactElement<RadialPointSeriesProps> \| null` | `<RadialPointSeries show />` | Data point symbols (always visible) |
| `tooltip` | `ReactElement<TooltipAreaProps>` | `<TooltipArea />` | Tooltip component |
| `valueMarkers` | `ReactElement<RadialValueMarkerProps>[] \| null` | — | Value marker lines |
| `isClosedCurve` | `boolean` | `true` | Close the polygon |

## RadialLine Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `strokeWidth` | `number` | `2` | Line thickness |
| `animated` | `boolean` | `true` | Enable animations |
| `isClosedCurve` | `boolean` | `true` | Close the curve |
| `className` | `string` | — | CSS class |

## RadialArea Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `gradient` | `ReactElement<RadialGradientProps> \| null` | `<RadialGradient />` | Gradient fill |
| `isClosedCurve` | `boolean` | `true` | Close the curve |
| `className` | `string` | — | CSS class |

## RadialPointSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `show` | `boolean \| 'hover' \| 'first' \| 'last'` | `'hover'` | When to show points |
| `point` | `ReactElement<RadialScatterPointProps>` | `<RadialScatterPoint />` | Point element |

## RadialAxis Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `'value' \| 'time' \| 'category'` | `'value'` | Axis type |
| `innerRadius` | `number` | `10` | Inner radius |
| `arcs` | `ReactElement<RadialAxisArcSeriesProps> \| null` | `<RadialAxisArcSeries />` | Background arcs |
| `ticks` | `ReactElement<RadialAxisTickSeriesProps> \| null` | `<RadialAxisTickSeries />` | Tick marks/labels |
| `startAngle` | `number` | `0` | Start angle |
| `endAngle` | `number` | `Math.PI * 2` | End angle |

## RadialAxisArcSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `count` | `number` | `12` | Number of concentric arcs |
| `arc` | `ReactElement<RadialAxisArcProps>` | `<RadialAxisArc />` | Arc element |

## Basic Usage

```tsx
const data = [
  { key: 'Q1', data: [
    { key: 'Speed', data: 80 },
    { key: 'Reliability', data: 70 },
    { key: 'Comfort', data: 60 },
    { key: 'Safety', data: 90 },
    { key: 'Efficiency', data: 75 },
  ]},
  { key: 'Q2', data: [
    { key: 'Speed', data: 65 },
    { key: 'Reliability', data: 85 },
    { key: 'Comfort', data: 70 },
    { key: 'Safety', data: 80 },
    { key: 'Efficiency', data: 90 },
  ]},
];

<RadarChart
  height={500}
  width={500}
  data={data}
/>
```

## Filled Radar (with Area)

```tsx
import { RadialArea, RadialGradient, GradientStop } from 'reaviz';

<RadarChart
  data={data}
  height={500}
  width={500}
  series={
    <RadarChartSeries
      area={
        <RadialArea
          gradient={
            <RadialGradient
              stops={[
                <GradientStop offset="0%" stopOpacity={0.1} key="start" />,
                <GradientStop offset="80%" stopOpacity={0.3} key="stop" />,
              ]}
            />
          }
        />
      }
    />
  }
/>
```

## Custom Axis Arcs

```tsx
<RadarChart
  data={data}
  axis={
    <RadialAxis
      type="category"
      arcs={<RadialAxisArcSeries count={5} />}
      ticks={<RadialAxisTickSeries />}
    />
  }
/>
```

## No Points (Line Only)

```tsx
<RadarChart
  data={data}
  series={<RadarChartSeries symbols={null} />}
/>
```

## Custom Line Width

```tsx
import { RadialLine } from 'reaviz';

<RadarChart
  data={data}
  series={
    <RadarChartSeries
      line={<RadialLine strokeWidth={4} />}
    />
  }
/>
```

## Notes

- RadarChart is a wrapper around RadialAreaChart with radar-specific defaults: `area={null}`, `type="grouped"`, `symbols` always visible
- Data must be nested (`ChartNestedDataShape[]`) — each top-level entry is a series, inner entries are category values
- Categories should be consistent across all series for proper axis alignment
- `interpolation="smooth"` produces rounded polygons; use `"linear"` for sharp-cornered radar shapes
- Default margins are `75` to accommodate axis labels around the perimeter
