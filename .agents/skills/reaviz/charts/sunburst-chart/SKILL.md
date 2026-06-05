# SunburstChart

Hierarchical radial chart displaying nested data as concentric rings of arcs. Inner rings represent parent categories, outer rings represent children. Supports gradients, tooltips, and animated transitions.

## Import

```tsx
import {
  SunburstChart,
  SunburstSeries,
  SunburstArc,
  SunburstArcLabel
} from 'reaviz';
```

## SunburstChart Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[] \| ChartNestedDataShape[]` | `[]` | Chart data (flat or hierarchical) |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `0` | Chart margins |
| `series` | `ReactElement<SunburstSeriesProps>` | `<SunburstSeries />` | Series component |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## SunburstSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `arc` | `ReactElement<SunburstArcProps>` | `<SunburstArc />` | Arc element |
| `label` | `ReactElement<SunburstArcLabelProps>` | `<SunburstArcLabel />` | Label element |

## SunburstArc Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `cursor` | `string` | `'pointer'` | CSS cursor on hover |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `gradient` | `ReactElement<GradientProps> \| null` | — | Gradient fill |
| `onClick` | `(event, data) => void` | — | Click handler |
| `onMouseEnter` | `(event, data) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event, data) => void` | — | Mouse leave handler |

## SunburstArcLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fill` | `string` | `'black'` | Text color (auto-inverted for contrast) |
| `fontSize` | `number` | `14` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `animated` | `boolean` | — | Enable animations |

## Basic Usage

```tsx
const data = [
  { key: 'Backend', data: [
    { key: 'API', data: [
      { key: 'REST', data: 50 },
      { key: 'GraphQL', data: 30 },
    ]},
    { key: 'Database', data: [
      { key: 'Postgres', data: 40 },
      { key: 'Redis', data: 20 },
    ]},
  ]},
  { key: 'Frontend', data: [
    { key: 'React', data: 60 },
    { key: 'CSS', data: 25 },
  ]},
];

<SunburstChart
  height={400}
  width={400}
  data={data}
/>
```

## With Gradient

```tsx
import { Gradient } from 'reaviz';

<SunburstChart
  data={data}
  series={
    <SunburstSeries
      arc={<SunburstArc gradient={<Gradient />} />}
    />
  }
/>
```

## Custom Color Scheme

```tsx
<SunburstChart
  data={data}
  series={
    <SunburstSeries colorScheme={['#FF5722', '#2196F3', '#4CAF50']} />
  }
/>
```

## Click Handling

```tsx
<SunburstChart
  data={data}
  series={
    <SunburstSeries
      arc={
        <SunburstArc
          onClick={(event, d) => console.log(d)}
        />
      }
    />
  }
/>
```

## No Animation

```tsx
<SunburstChart
  data={data}
  series={<SunburstSeries animated={false} />}
/>
```

## No Labels

```tsx
<SunburstChart
  data={data}
  series={<SunburstSeries label={null} />}
/>
```

## Notes

- Data can be flat (`ChartShallowDataShape[]`) or nested (`ChartNestedDataShape[]`) — nesting depth determines ring count
- Labels are auto-ellipsized to 10 characters and only rendered when the arc is large enough (area > 0.05)
- Label text color is automatically inverted from the arc fill for contrast
- Arcs brighten on hover (chroma brightness factor of 0.5)
- Uses D3 partition layout to compute arc positions from hierarchical data
