# FunnelChart

Funnel visualization for conversion/pipeline data. Segments taper from wide to narrow based on value. Supports default and layered variants with configurable interpolation, gradients, axis labels, and tooltips.

## Import

```tsx
import {
  FunnelChart,
  FunnelSeries,
  FunnelArc,
  FunnelAxis,
  FunnelAxisLabel,
  FunnelAxisLine
} from 'reaviz';
```

## FunnelChart Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `0` | Chart margins |
| `series` | `ReactElement<FunnelSeriesProps>` | `<FunnelSeries />` | Series component |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## FunnelSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `arc` | `ReactElement<FunnelArcProps>` | `<FunnelArc />` | Arc/segment element |
| `axis` | `ReactElement<FunnelAxisProps>` | `<FunnelAxis />` | Axis component |
| `onSegmentClick` | `(event: ClickEvent) => void` | — | Segment click handler |

## FunnelArc Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'default' \| 'layered'` | `'default'` | Funnel style |
| `interpolation` | `'linear' \| 'smooth' \| 'step'` | `'smooth'` | Curve interpolation |
| `colorScheme` | `ColorSchemeType` | `schemes.cybertron[0]` | Color scheme (single color by default) |
| `opacity` | `number` | `1` | Arc opacity |
| `gradient` | `ReactElement<GradientProps> \| null` | horizontal gradient | Gradient fill (`null` to disable) |
| `glow` | `Glow` | — | Glow effect |
| `tooltip` | `ReactElement<TooltipAreaProps>` | `null` | Tooltip component |

## FunnelAxis Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `line` | `ReactElement<FunnelAxisLineProps> \| null` | `<FunnelAxisLine />` | Axis separator lines |
| `label` | `ReactElement<FunnelAxisLabelProps> \| null` | `<FunnelAxisLabel />` | Axis labels |

## FunnelAxisLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `position` | `'top' \| 'middle' \| 'bottom'` | `'middle'` | Label placement |
| `showValue` | `boolean` | `true` | Show data value alongside label |
| `labelVisibility` | `'auto' \| 'always'` | `'auto'` | Auto-hide when space is tight |
| `fill` | `string` | `'#fff'` | Text color |
| `fontSize` | `number` | `13` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `padding` | `number` | `10` | Label padding |
| `className` | `string` | — | CSS class |

## FunnelAxisLine Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `strokeColor` | `string` | `'#333'` | Line color |
| `strokeWidth` | `number` | `2` | Line thickness |

## Basic Usage

```tsx
const data = [
  { key: 'Visited Site', data: 1000 },
  { key: 'Added to Cart', data: 900 },
  { key: 'Initiated Checkout', data: 600 },
  { key: 'Purchased', data: 400 },
];

<FunnelChart
  height={300}
  width={500}
  data={data}
/>
```

## Layered Variant

```tsx
<FunnelChart
  height={400}
  width={800}
  data={data}
  series={
    <FunnelSeries
      arc={
        <FunnelArc
          variant="layered"
          colorScheme={['#013027', '#047662', '#06B899']}
          gradient={null}
        />
      }
    />
  }
/>
```

## With Tooltips and Click

```tsx
import { TooltipArea } from 'reaviz';

<FunnelChart
  data={data}
  series={
    <FunnelSeries
      arc={<FunnelArc tooltip={<TooltipArea />} />}
      onSegmentClick={(e) => console.log(e.value)}
    />
  }
/>
```

## Step Interpolation

```tsx
<FunnelChart
  data={data}
  series={
    <FunnelSeries
      arc={<FunnelArc interpolation="step" />}
    />
  }
/>
```

## Label Positioning

```tsx
// Labels at bottom
<FunnelChart
  data={data}
  series={
    <FunnelSeries
      axis={<FunnelAxis label={<FunnelAxisLabel position="bottom" />} />}
    />
  }
/>

// Hide values, show only labels
<FunnelChart
  data={data}
  series={
    <FunnelSeries
      axis={<FunnelAxis label={<FunnelAxisLabel showValue={false} />} />}
    />
  }
/>

// No axis at all
<FunnelChart
  data={data}
  series={
    <FunnelSeries
      axis={<FunnelAxis label={null} line={null} />}
    />
  }
/>
```

## No Gradient

```tsx
<FunnelChart
  data={data}
  series={
    <FunnelSeries
      arc={<FunnelArc gradient={null} colorScheme="cybertron" />}
    />
  }
/>
```

## Notes

- Default gradient is horizontal, fading from full opacity to 50% opacity
- `variant="layered"` renders segments as overlapping layers instead of connected shapes
- `labelVisibility="auto"` hides labels that don't fit within their segment
- Data should be ordered from largest to smallest for a standard funnel shape
