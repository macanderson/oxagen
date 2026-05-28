# BubbleChart

Packed circle chart using D3 circle-packing layout. Bubble size is proportional to data value. Supports labels, gradients, masks, and custom bubble rendering.

## Import

```tsx
import { BubbleChart, BubbleSeries, Bubble, BubbleLabel } from 'reaviz';
```

## BubbleChart Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `10` | Chart margins |
| `series` | `ReactElement<BubbleSeriesProps>` | `<BubbleSeries />` | Series component |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## BubbleSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `bubble` | `ReactElement<BubbleProps>` | `<Bubble />` | Bubble element |
| `label` | `ReactElement<BubbleLabelProps>` | `<BubbleLabel />` | Label element |
| `format` | `(item) => ReactElement<BubbleProps>` | — | Custom bubble renderer (overrides `bubble` prop) |

## Bubble Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `gradient` | `ReactElement<GradientProps> \| null` | — | Gradient fill |
| `mask` | `ReactElement<MaskProps> \| null` | — | SVG pattern mask |
| `glow` | `Glow` | — | Glow effect |
| `onClick` | `(event, node) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

## BubbleLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `wrap` | `boolean` | `true` | Wrap long text |
| `fontSize` | `number` | `14` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `fill` | `string` | — | Text color (auto-inverted from bubble color if not set) |
| `format` | `(data) => any` | — | Custom label formatter |

## Basic Usage

```tsx
const data = [
  { key: 'AWS', data: 100 },
  { key: 'SendGrid', data: 45 },
  { key: 'Okta', data: 75 },
  { key: 'Twilio', data: 25 },
];

<BubbleChart
  width={450}
  height={350}
  data={data}
/>
```

## With Gradient

```tsx
import { Gradient } from 'reaviz';

<BubbleChart
  data={data}
  series={
    <BubbleSeries
      bubble={<Bubble gradient={<Gradient />} />}
    />
  }
/>
```

## With Pattern Mask

```tsx
import { Stripes } from 'reaviz';

<BubbleChart
  data={data}
  series={
    <BubbleSeries
      bubble={<Bubble mask={<Stripes />} />}
    />
  }
/>
```

## Custom Label Format

```tsx
<BubbleChart
  data={data}
  series={
    <BubbleSeries
      label={<BubbleLabel format={(d) => `${d.data.key}: ${d.data.data}`} />}
    />
  }
/>
```

## Custom Bubble Rendering (Icons)

```tsx
<BubbleChart
  data={data}
  series={
    <BubbleSeries
      format={(item) => (
        <Bubble
          tooltip={<ChartTooltip />}
          // render custom content inside bubble
        />
      )}
    />
  }
/>
```

## No Animation

```tsx
<BubbleChart
  data={data}
  series={<BubbleSeries animated={false} />}
/>
```

## Notes

- Uses D3 `pack` layout to compute circle positions and sizes
- Label text color is automatically inverted from the bubble fill for contrast
- Long labels wrap by default within the bubble bounds
- Autosize: omit `width`/`height` and the chart fills its container
