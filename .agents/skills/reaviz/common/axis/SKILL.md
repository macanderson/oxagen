# Axis

Linear axis components for cartesian charts. Configurable tick formatting, label rotation, positioning, and axis line styling.

## Import

```tsx
import {
  LinearXAxis,
  LinearXAxisTickSeries,
  LinearXAxisTickLabel,
  LinearXAxisTickLine,
  LinearYAxis,
  LinearYAxisTickSeries,
  LinearYAxisTickLabel,
  LinearYAxisTickLine,
  LinearAxisLine
} from 'reaviz';
```

## LinearXAxis / LinearYAxis Props

| Prop | Type | Default (X) | Default (Y) | Description |
|------|------|-------------|-------------|-------------|
| `type` | `'value' \| 'time' \| 'category' \| 'duration'` | `'value'` | `'value'` | Scale type |
| `position` | `'start' \| 'end' \| 'center'` | `'end'` | `'start'` | Axis placement |
| `orientation` | `'horizontal' \| 'vertical'` | `'horizontal'` | `'vertical'` | Axis direction |
| `scaled` | `boolean` | `false` | `false` | Scale to data extent |
| `roundDomains` | `boolean` | `false` | `false` | Round domain values |
| `domain` | `ChartDataTypes[]` | — | — | Custom domain |
| `tickSeries` | `ReactElement` | `<LinearXAxisTickSeries />` | `<LinearYAxisTickSeries />` | Tick series component |
| `axisLine` | `ReactElement \| null` | `<LinearAxisLine />` | `<LinearAxisLine />` | Axis line (`null` to hide) |
| `visibility` | `'visible' \| 'hidden'` | — | — | Axis visibility |
| `scale` | `any` | — | — | Custom D3 scale |

## Tick Series Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `tickSize` | `number` | X: `75`, Y: `30` | Spacing between ticks |
| `interval` | `number \| TimeInterval` | — | Custom tick interval |
| `ellipsisLength` | `number` | `18` | Max label characters before ellipsis |
| `label` | `ReactElement \| null` | `<LinearAxisTickLabel />` | Tick label (`null` to hide) |
| `line` | `ReactElement \| null` | `<LinearAxisTickLine />` | Tick line (`null` to hide) |

## Tick Label Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `format` | `(value) => any` | — | Custom label formatter |
| `formatTooltip` | `(value) => any` | — | Tooltip format for truncated labels |
| `rotation` | `boolean \| number` | X: `true`, Y: `false` | Auto-rotate or fixed angle |
| `padding` | `number \| { fromAxis, alongAxis }` | `5` | Label padding |
| `fill` | `string` | `'#8F979F'` | Text color |
| `fontSize` | `number` | `11` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `align` | `'start' \| 'end' \| 'center' \| 'inside' \| 'outside'` | `'center'` | Label alignment |
| `position` | `'start' \| 'end' \| 'center'` | X: `'end'`, Y: `'start'` | Label position |
| `textAnchor` | `'start' \| 'end' \| 'middle'` | — | SVG text anchor |
| `className` | `string` | — | CSS class |
| `onClick` | `(event, data) => void` | — | Label click handler |

## Tick Line Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `number` | `5` | Tick line length |
| `strokeColor` | `string` | `'#8F979F'` | Line color |
| `strokeWidth` | `number` | `1` | Line thickness |
| `position` | `'start' \| 'end' \| 'center'` | X: `'end'`, Y: `'start'` | Line position |

## Axis Line Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `strokeColor` | `string` | `'#8F979F'` | Line color |
| `strokeWidth` | `number` | `1` | Line thickness |
| `strokeGradient` | `ReactElement<GradientProps> \| null` | — | Gradient for axis line |

## Custom Tick Formatting

```tsx
import { LinearYAxis, LinearYAxisTickSeries, LinearYAxisTickLabel } from 'reaviz';

<AreaChart
  data={data}
  yAxis={
    <LinearYAxis
      type="value"
      tickSeries={
        <LinearYAxisTickSeries
          label={
            <LinearYAxisTickLabel
              format={(v) => `$${v.toLocaleString()}`}
            />
          }
        />
      }
    />
  }
/>
```

## Hide Axis Labels (Keep Line)

```tsx
<LinearXAxis
  type="time"
  tickSeries={<LinearXAxisTickSeries label={null} />}
/>
```

## Hide Tick Lines (Keep Labels)

```tsx
<LinearYAxis
  type="value"
  tickSeries={<LinearYAxisTickSeries line={null} />}
/>
```

## Hide Entire Axis

```tsx
<AreaChart
  data={data}
  xAxis={<LinearXAxis visibility="hidden" />}
/>
```

## Remove Axis Line

```tsx
<LinearYAxis type="value" axisLine={null} />
```

## Fixed Label Rotation

```tsx
<LinearXAxisTickLabel rotation={45} />
```

## Category Axis

```tsx
<LinearXAxis type="category" />
```

## Time Axis with Custom Interval

```tsx
import { timeMonth } from 'd3-time';

<LinearXAxis
  type="time"
  tickSeries={<LinearXAxisTickSeries interval={timeMonth.every(3)} />}
/>
```
