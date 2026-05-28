# Meter

Segmented column strip showing a value as filled/unfilled blocks. Useful for discrete progress or threshold indicators.

## Import

```tsx
import { Meter, MeterColumn } from 'reaviz';
```

## Meter Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `number` | — | Current value (required) |
| `min` | `number` | `0` | Minimum value |
| `max` | `number` | `100` | Maximum value |
| `columns` | `number` | `10` | Number of segments |
| `gap` | `number` | `15` | Gap between segments |
| `column` | `ReactElement<MeterColumnProps> \| null` | `<MeterColumn />` | Column element |
| `className` | `string` | — | CSS class |
| `style` | `React.CSSProperties` | `{}` | Inline styles |

## MeterColumn Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `height` | `number` | `32` | Column height |
| `activeFill` | `string` | `schemes.cybertron[0]` | Filled segment color |
| `inActiveFill` | `string` | `'#414242'` | Empty segment color |
| `animated` | `boolean` | `true` | Enable animations |
| `className` | `string` | — | CSS class |

## Basic Usage

```tsx
<Meter value={75} />
```

## Custom Range and Segments

```tsx
<Meter
  value={350}
  min={0}
  max={500}
  columns={20}
  gap={8}
/>
```

## Custom Colors

```tsx
<Meter
  value={60}
  column={
    <MeterColumn
      height={24}
      activeFill="#2196F3"
      inActiveFill="#1a1a1a"
    />
  }
/>
```

## Compact Meter

```tsx
<Meter
  value={40}
  columns={5}
  gap={4}
  column={<MeterColumn height={16} />}
/>
```

## No Animation

```tsx
<Meter
  value={80}
  column={<MeterColumn animated={false} />}
/>
```

## Notes

- Renders as SVG rectangles, not HTML
- Segments fill left-to-right based on the value's position within the min/max range
- Each segment animates in with staggered delay when `animated` is true
