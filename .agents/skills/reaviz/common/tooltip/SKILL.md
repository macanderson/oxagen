# Tooltip

Hover tooltips for chart data. `TooltipArea` handles mouse tracking and value lookup; `ChartTooltip` renders the popup; `TooltipTemplate` formats the content.

## Import

```tsx
import { ChartTooltip, TooltipArea, TooltipTemplate } from 'reaviz';
```

## ChartTooltip Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `ReactElement \| (data, color) => ReactNode` | `<TooltipTemplate />` | Tooltip content renderer |
| `followCursor` | `boolean` | — | Move tooltip with cursor |
| `value` | `any` | — | Data value (set internally) |
| `color` | `any` | — | Series color (set internally) |
| `data` | `any` | — | Full dataset (set internally) |

Also accepts `TooltipProps` from reablocks (placement, modifiers, etc.).

## TooltipArea Props

Most props are set internally by the parent chart. User-configurable:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `tooltip` | `ReactElement<ChartTooltipProps>` | `<ChartTooltip />` | Tooltip component |
| `disabled` | `boolean` | — | Disable tooltips |
| `inverse` | `boolean` | `true` | Inverse data lookup |
| `placement` | `Placement` | — | Tooltip placement |
| `onValueEnter` | `(event: TooltipAreaEvent) => void` | — | Value hover callback |
| `onValueLeave` | `() => void` | — | Value leave callback |

## TooltipTemplate Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `SingleTooltipValue \| MultipleTooltipValues` | — | Tooltip data |
| `color` | `any` | — | Series color |
| `className` | `string` | — | CSS class |

## Default Tooltip (Built-in)

Most charts include tooltips by default — no configuration needed.

## Custom Tooltip Content

```tsx
<AreaChart
  data={data}
  series={
    <AreaSeries
      tooltip={
        <TooltipArea
          tooltip={
            <ChartTooltip
              content={(d, color) => (
                <div>
                  <strong>{d.x}</strong>: {d.y}
                </div>
              )}
            />
          }
        />
      }
    />
  }
/>
```

## Follow Cursor

```tsx
<ChartTooltip followCursor={true} />
```

## Custom Placement

```tsx
import { offset } from '@floating-ui/dom';

<ChartTooltip
  followCursor={true}
  modifiers={[offset(5)]}
/>
```

## Disable Tooltips

```tsx
<AreaSeries tooltip={<TooltipArea disabled />} />

// Or completely remove
<BarSeries tooltip={null} />
```

## Tooltip Value Events

```tsx
<TooltipArea
  onValueEnter={(event) => {
    console.log('Hovered:', event.value);
  }}
  onValueLeave={() => {
    console.log('Left');
  }}
/>
```
