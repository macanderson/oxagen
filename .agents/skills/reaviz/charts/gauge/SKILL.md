# Gauge

Two gauge components for displaying progress/metric values: **LinearGauge** (horizontal bar) and **RadialGauge** (circular arc with optional stacking).

## Import

```tsx
// Linear
import { LinearGauge, LinearGaugeSeries, LinearGaugeBar, LinearGaugeOuterBar } from 'reaviz';

// Radial
import {
  RadialGauge,
  RadialGaugeSeries,
  RadialGaugeArc,
  RadialGaugeOuterArc,
  RadialGaugeLabel,
  RadialGaugeValueLabel,
  StackedRadialGaugeSeries,
  StackedRadialGaugeValueLabel,
  StackedRadialGaugeDescriptionLabel,
  RadialGaugeStackedArc
} from 'reaviz';
```

---

## LinearGauge

Horizontal progress bar gauge with an outer track and inner fill bar.

### LinearGauge Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape \| ChartShallowDataShape[]` | — | Single or multi-series data |
| `minValue` | `number` | `0` | Minimum scale value (single-series only) |
| `maxValue` | `number` | `100` | Maximum scale value (single-series only) |
| `series` | `ReactElement<LinearGaugeSeriesProps>` | `<LinearGaugeSeries />` | Series component |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

### LinearGaugeSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `bar` | `ReactElement<LinearGaugeBarProps>` | `<LinearGaugeBar />` | Inner fill bar (single-series) |
| `outerBar` | `ReactElement<LinearGaugeOuterBarProps>` | `<LinearGaugeOuterBar />` | Outer track bar (single-series) |

Inherits BarSeries props (`colorScheme`, `animated`, `padding`, `tooltip`, etc.).

### LinearGaugeOuterBar Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fill` | `string` | `'#484848'` | Track fill color |

### Basic Usage

```tsx
<LinearGauge
  height={5}
  width={300}
  data={{ key: 'Progress', data: 75 }}
/>
```

### Custom Min/Max

```tsx
<LinearGauge
  data={{ key: 'Score', data: 350 }}
  minValue={0}
  maxValue={500}
/>
```

### Multi-Series

```tsx
<LinearGauge
  height={30}
  width={300}
  data={[
    { key: 'Low', data: 25 },
    { key: 'Med', data: 50 },
    { key: 'High', data: 75 },
  ]}
  series={<LinearGaugeSeries colorScheme="cybertron" />}
/>
```

---

## RadialGauge

Circular arc gauge supporting single, multi-ring, and stacked layouts.

### RadialGauge Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartDataShape[]` | — | Chart data |
| `minValue` | `number \| number[]` | `0` | Minimum scale value(s) |
| `maxValue` | `number \| number[]` | `100` | Maximum scale value(s) |
| `startAngle` | `number` | `0` | Start angle in radians |
| `endAngle` | `number` | `Math.PI * 2` | End angle in radians (full circle) |
| `series` | `ReactElement` | `<RadialGaugeSeries />` | Series component |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

### RadialGaugeSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `arcWidth` | `number` | `5` | Arc thickness |
| `padding` | `number` | `20` | Padding between rings (multi-series) |
| `colorScheme` | `ColorSchemeType` | `['#00ECB1']` | Color scheme |
| `innerArc` | `ReactElement<RadialGaugeArcProps>` | `<RadialGaugeArc />` | Value arc component |
| `outerArc` | `ReactElement<RadialGaugeArcProps> \| null` | `<RadialGaugeOuterArc />` | Track arc component |
| `label` | `ReactElement<RadialGaugeLabelProps> \| null` | `<RadialGaugeLabel />` | Key label |
| `valueLabel` | `ReactElement<RadialGaugeValueLabelProps> \| null` | `<RadialGaugeValueLabel />` | Value label |
| `minGaugeWidth` | `number` | `50` | Min width per ring (multi-series) |

### RadialGaugeArc Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `cornerRadius` | `number` | `0` | Arc corner rounding |
| `padAngle` | `number` | `0` | Padding angle between arcs |
| `padRadius` | `number` | — | Padding radius |
| `animated` | `boolean` | `true` | Enable animations |
| `disabled` | `boolean` | `false` | Disable interactions |
| `fill` | `string` | — | Override fill color |
| `gradient` | `ReactElement<GradientProps> \| null` | — | Gradient fill |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `onClick` | `(event) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

### StackedRadialGaugeSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `colorScheme` | `ColorSchemeType` | `['#00ECB1']` | Color scheme |
| `innerArc` | `ReactElement<RadialGaugeArcProps>` | `<RadialGaugeArc />` | Inner arc |
| `stackedInnerArc` | `ReactElement<RadialGaugeStackedArcProps>` | `<RadialGaugeStackedArc />` | Stacked arc |
| `outerArc` | `ReactElement<RadialGaugeArcProps> \| null` | disabled RadialGaugeArc | Track arc |
| `label` | `ReactElement \| null` | `<StackedRadialGaugeValueLabel />` | Center label |
| `descriptionLabel` | `ReactElement \| null` | — | Description below label |
| `fillFactor` | `number` | `0.2` | How much of the gauge is filled (0-1) |
| `arcPadding` | `number` | `0.15` | Padding between stacked arcs |

### Basic Usage

```tsx
<RadialGauge
  height={300}
  width={300}
  data={[{ key: 'CPU', data: 75 }]}
/>
```

### Multi-Ring

```tsx
<RadialGauge
  height={300}
  width={300}
  data={[
    { key: 'CPU', data: 75 },
    { key: 'Memory', data: 50 },
    { key: 'Disk', data: 30 },
  ]}
  series={
    <RadialGaugeSeries
      colorScheme={['#00ECB1', '#2196F3', '#FF5722']}
      arcWidth={10}
    />
  }
/>
```

### Stacked

```tsx
<RadialGauge
  height={300}
  width={300}
  data={[
    { key: 'Q1', data: [
      { key: 'Sales', data: 30 },
      { key: 'Revenue', data: 50 },
    ]},
  ]}
  series={
    <StackedRadialGaugeSeries
      label={<StackedRadialGaugeValueLabel label="Total" />}
      colorScheme={['#00ECB1', '#2196F3']}
    />
  }
/>
```

### Half Gauge (180 degrees)

```tsx
<RadialGauge
  data={[{ key: 'Score', data: 65 }]}
  startAngle={-Math.PI / 2}
  endAngle={Math.PI / 2}
/>
```

### With Gradient

```tsx
import { Gradient } from 'reaviz';

<RadialGauge
  data={[{ key: 'Status', data: 80 }]}
  series={
    <RadialGaugeSeries
      innerArc={<RadialGaugeArc gradient={<Gradient />} />}
    />
  }
/>
```

### Rounded Arcs

```tsx
<RadialGauge
  data={[{ key: 'Score', data: 75 }]}
  series={
    <RadialGaugeSeries
      innerArc={<RadialGaugeArc cornerRadius={10} />}
    />
  }
/>
```

