# Range

Slider components for single value or dual-handle range selection. Draggable handles with tooltip display using Framer Motion.

## Import

```tsx
import { RangeSingle, RangeDouble } from 'reablocks';
```

## Common Props (RangeProps)

Both RangeSingle and RangeDouble share these base props:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `min` | `number` | — | Minimum value |
| `max` | `number` | — | Maximum value |
| `step` | `number` | `1` | Step increment |
| `disabled` | `boolean` | — | Disable the slider |
| `valueDisplay` | `'always' \| 'hover'` | `'hover'` | When to show value tooltip |
| `valueFormat` | `(value: number) => string` | `toLocaleString` | Format displayed value |
| `style` | `CSSProperties` | — | Inline styles |
| `className` | `string` | — | Container CSS classes |
| `handleClassName` | `string` | — | Handle CSS classes |
| `theme` | `RangeTheme` | — | Per-instance theme override |

## RangeSingle

Single-handle slider. Value is a single `number`.

### Additional Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `number` | — | Current value |
| `showHighlight` | `boolean` | `false` | Show filled track from min to value |
| `onChange` | `(value: number) => void` | — | Value change handler |

```tsx
const [value, setValue] = useState(50);

<RangeSingle min={0} max={100} value={value} onChange={setValue} />
<RangeSingle min={0} max={100} value={value} onChange={setValue} showHighlight />
```

## RangeDouble

Dual-handle slider for selecting a range. Value is a `[number, number]` tuple.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `[number, number]` | — | Current range [min, max] |
| `onChange` | `(value: [number, number]) => void` | — | Range change handler |

```tsx
const [range, setRange] = useState<[number, number]>([20, 80]);

<RangeDouble min={0} max={100} value={range} onChange={setRange} />
```

The two handles maintain a minimum distance of `step` between them.

## RangeTheme Interface

```typescript
interface RangeTheme {
  base: string;          // Track container (relative, w-full, h-0.5, bg)
  drag: string;          // Handle (absolute, rounded-full, positioned)
  disabled: string;      // Disabled state
  inputWrapper: {
    base: string;        // Handle inner (cursor-pointer, rounded, bg, shadow)
    disabled: string;    // Disabled handle
  };
  rangeHighlight: {
    base: string;        // Filled track segment
    disabled: string;
  };
  input: string;         // Hidden range input (offscreen)
  tooltip: string;       // Value tooltip (absolute, positioned above)
}
```
