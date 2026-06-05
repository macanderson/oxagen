# PieChart

Pie and donut chart using D3 pie layout. Supports exploded slices, rounded/spaced arcs, labels with connector lines, gradients, and custom label rendering.

## Import

```tsx
import { PieChart, PieArcSeries, PieArc, PieArcLabel } from 'reaviz';
```

## PieChart Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `10` | Chart margins |
| `series` | `ReactElement<PieArcSeriesProps>` | `<PieArcSeries />` | Series component |
| `disabled` | `boolean` | — | Disable the chart |
| `displayAllLabels` | `boolean` | — | Show labels even when space is tight |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## PieArcSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `doughnut` | `boolean` | `false` | Render as donut (hollow center) |
| `arcWidth` | `number` | `0.25` | Arc thickness ratio (donut mode) |
| `explode` | `boolean` | `false` | Adjust outer radius proportionally to value |
| `cornerRadius` | `number` | `0` | Arc corner rounding |
| `padAngle` | `number` | `0` | Padding angle between arcs |
| `padRadius` | `number` | `0` | Padding radius between arcs |
| `displayAllLabels` | `boolean` | `false` | Show all labels regardless of space |
| `arc` | `ReactElement<PieArcProps>` | `<PieArc />` | Arc element |
| `label` | `ReactElement<PieArcLabelProps> \| null` | `<PieArcLabel />` | Label element (`null` to hide) |

## PieArc Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `animated` | `boolean` | `true` | Enable animations |
| `cursor` | `string` | `'initial'` | CSS cursor on hover |
| `disabled` | `boolean` | `false` | Disable interactions |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `gradient` | `ReactElement<GradientProps> \| null` | — | Gradient fill |
| `style` | `MotionStyle` | — | Custom motion styles |
| `onClick` | `(e: PieArcMouseEvent) => void` | — | Click handler |
| `onMouseEnter` | `(e: PieArcMouseEvent) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(e: PieArcMouseEvent) => void` | — | Mouse leave handler |

## PieArcLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `format` | `(data) => ReactNode` | — | Custom label formatter |
| `fontFill` | `string` | `'#8F979F'` | Text color |
| `fontSize` | `number` | `11` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `lineStroke` | `string` | `'rgba(127,127,127,0.5)'` | Connector line color |
| `padding` | `string` | `'.35em'` | Label padding |
| `height` | `number` | `11` | Label height |

## Basic Pie Chart

```tsx
const data = [
  { key: 'Phishing', data: 10 },
  { key: 'Malware', data: 8 },
  { key: 'DDoS', data: 5 },
  { key: 'Ransomware', data: 3 },
];

<PieChart
  width={350}
  height={250}
  data={data}
/>
```

## Donut Chart

```tsx
<PieChart
  width={350}
  height={250}
  data={data}
  series={<PieArcSeries doughnut={true} />}
/>
```

## Rounded and Spaced Donut

```tsx
<PieChart
  data={data}
  series={
    <PieArcSeries
      doughnut={true}
      cornerRadius={4}
      padAngle={0.02}
      padRadius={200}
    />
  }
/>
```

## Exploded Slices

```tsx
<PieChart
  data={data}
  series={<PieArcSeries explode={true} />}
/>
```

## With Gradient

```tsx
import { Gradient } from 'reaviz';

<PieChart
  data={data}
  series={
    <PieArcSeries
      arc={<PieArc gradient={<Gradient />} />}
    />
  }
/>
```

## Custom Label Format

```tsx
<PieChart
  data={data}
  series={
    <PieArcSeries
      label={
        <PieArcLabel
          format={(d) => `${d.key}: ${d.data}`}
        />
      }
    />
  }
/>
```

## HTML Labels (Custom Rendering)

```tsx
<PieChart
  data={data}
  series={
    <PieArcSeries
      label={
        <PieArcLabel
          format={(d) => (
            <tspan>
              <tspan fontWeight="bold">{d.key}</tspan>
              <tspan dx={5}>{d.data}</tspan>
            </tspan>
          )}
        />
      }
    />
  }
/>
```

## No Labels

```tsx
<PieChart
  data={data}
  series={<PieArcSeries label={null} />}
/>
```

## Display All Labels

```tsx
<PieChart
  data={data}
  displayAllLabels={true}
/>
```

## Click Handling

```tsx
<PieChart
  data={data}
  series={
    <PieArcSeries
      arc={
        <PieArc
          cursor="pointer"
          onClick={({ value, nativeEvent }) => console.log(value)}
        />
      }
    />
  }
/>
```

## Donut with Center Label

```tsx
<div style={{ position: 'relative' }}>
  <PieChart
    data={data}
    series={<PieArcSeries doughnut={true} />}
  />
  <div style={{
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
  }}>
    <strong>Total: 26</strong>
  </div>
</div>
```

## No Animation

```tsx
<PieChart
  data={data}
  series={<PieArcSeries animated={false} />}
/>
```

## Notes

- Labels use automatic collision detection and repositioning
- Connector lines are drawn from arc centroid to label position
- `arcWidth` controls donut hole size as a ratio (0-1) — smaller value = thicker ring
- `explode` adjusts outer radius proportionally so larger slices extend further
- `displayAllLabels` forces labels to render even for very small slices
