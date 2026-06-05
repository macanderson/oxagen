# Gradient & Mask

SVG gradient fills and pattern masks for chart elements. Apply to areas, bars, arcs, and other shapes.

## Import

```tsx
import { Gradient, GradientStop, RadialGradient, Mask, Stripes } from 'reaviz';
```

## Gradient Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `direction` | `'vertical' \| 'horizontal' \| 'radial'` | `'vertical'` | Gradient direction |
| `color` | `string` | — | Base color (applied to all stops) |
| `stops` | `ReactElement<GradientStopProps>[]` | 0% opacity 0.3 → 80% opacity 1 | Color stops |

## GradientStop Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `offset` | `number \| string` | — | Position (e.g. `"0%"`, `"80%"`) |
| `stopOpacity` | `number \| string` | `1` | Opacity at this stop |
| `color` | `string` | — | Override color at this stop |

## RadialGradient Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `radius` | `number \| string` | `'30%'` | Gradient radius |
| `color` | `string` | — | Base color |
| `stops` | `ReactElement<GradientStopProps>[]` | 0% opacity 0.2 → 80% opacity 0.7 | Color stops |

## Mask Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `id` | `string` | — | Mask ID |
| `fill` | `string` | — | Mask fill color |

## Stripes Props

Extends Mask. Renders a 45-degree striped pattern.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `id` | `string` | — | Pattern ID |
| `fill` | `string` | — | Stripe color |

## Default Gradient

```tsx
// Most chart elements include <Gradient /> by default
<Area gradient={<Gradient />} />
```

## Custom Gradient Stops

```tsx
<Area
  gradient={
    <Gradient
      stops={[
        <GradientStop offset="0%" stopOpacity={0.1} />,
        <GradientStop offset="50%" stopOpacity={0.5} />,
        <GradientStop offset="100%" stopOpacity={1} />,
      ]}
    />
  }
/>
```

## Horizontal Gradient

```tsx
<Gradient direction="horizontal" />
```

## Radial Gradient (for radial charts)

```tsx
import { RadialArea, RadialGradient, GradientStop } from 'reaviz';

<RadialArea
  gradient={
    <RadialGradient
      stops={[
        <GradientStop offset="0%" stopOpacity={0.1} />,
        <GradientStop offset="80%" stopOpacity={0.3} />,
      ]}
    />
  }
/>
```

## Striped Mask

```tsx
<Area mask={<Stripes />} />
<Bar mask={<Stripes />} />
```

## Combined Gradient + Mask

```tsx
<Area
  mask={<Stripes />}
  gradient={
    <Gradient
      stops={[
        <GradientStop offset="10%" stopOpacity={0} />,
        <GradientStop offset="80%" stopOpacity={1} />,
      ]}
    />
  }
/>
```

## No Gradient

```tsx
<Area gradient={null} />
<Bar gradient={null} />
```
