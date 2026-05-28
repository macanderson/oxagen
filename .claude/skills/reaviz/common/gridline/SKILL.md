# Gridline

Background grid patterns for charts. Supports dashed lines in x/y/both directions and alternating stripe fills.

## Import

```tsx
import { GridlineSeries, Gridline, GridStripe } from 'reaviz';
```

## GridlineSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `line` | `ReactElement<GridlineProps> \| null` | `<Gridline direction="all" />` | Gridline component |
| `stripe` | `ReactElement<GridStripeProps> \| null` | — | Grid stripe component |

## Gridline Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `direction` | `'all' \| 'x' \| 'y'` | `'all'` | Which axes to draw lines for |
| `strokeWidth` | `number` | `1` | Line thickness |
| `strokeColor` | `string` | `'rgba(153, 153, 153, 0.5)'` | Line color |
| `strokeDasharray` | `string` | `'2 5'` | Dash pattern |
| `className` | `string` | — | CSS class |

## GridStripe Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fill` | `string` | `'#393c3e'` | Stripe fill color |
| `position` | `'horizontal' \| 'vertical'` | — | Stripe direction |
| `direction` | `'all' \| 'x' \| 'y'` | — | Which axes |
| `className` | `string` | — | CSS class |

## Default Gridlines

```tsx
// Already included by default in most charts
<AreaChart data={data} gridlines={<GridlineSeries />} />
```

## Horizontal Lines Only

```tsx
<GridlineSeries line={<Gridline direction="y" />} />
```

## Vertical Lines Only

```tsx
<GridlineSeries line={<Gridline direction="x" />} />
```

## Custom Color and Style

```tsx
<GridlineSeries
  line={
    <Gridline
      direction="all"
      strokeColor="rgba(255, 255, 255, 0.1)"
      strokeDasharray="5 10"
      strokeWidth={0.5}
    />
  }
/>
```

## Striped Background

```tsx
<GridlineSeries
  line={<Gridline direction="y" />}
  stripe={<GridStripe fill="rgba(255, 255, 255, 0.03)" />}
/>
```

## No Gridlines

```tsx
<AreaChart data={data} gridlines={null} />
```
