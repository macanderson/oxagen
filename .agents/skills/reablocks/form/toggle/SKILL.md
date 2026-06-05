# Toggle

On/off switch component with animated handle using Framer Motion spring animation. Supports sizes and custom animation configuration.

## Import

```tsx
import { Toggle } from 'reablocks';
```

## Toggle Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `checked` | `boolean` | — | Whether the toggle is on (required) |
| `disabled` | `boolean` | — | Disable the toggle |
| `animated` | `boolean` | `true` | Enable spring animation |
| `animation` | `MotionNodeAnimationOptions` | — | Custom Framer Motion animation config |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Toggle size |
| `onChange` | `(value: boolean) => void` | — | Change handler (receives new state) |
| `onBlur` | `(event: FocusEvent) => void` | — | Blur handler |
| `className` | `string` | — | Additional CSS classes |
| `theme` | `ToggleTheme` | — | Per-instance theme override |

Renders with `role="switch"`, `aria-checked`, keyboard support (Space).

## Basic Usage

```tsx
const [checked, setChecked] = useState(false);
<Toggle checked={checked} onChange={setChecked} />
```

## Sizes

```tsx
<Toggle checked={checked} onChange={setChecked} size="small" />
<Toggle checked={checked} onChange={setChecked} size="medium" />
<Toggle checked={checked} onChange={setChecked} size="large" />
```

## Disabled

```tsx
<Toggle disabled checked />
<Toggle disabled checked={false} />
```

## Custom Animation

```tsx
<Toggle
  checked={checked}
  onChange={setChecked}
  animation={{
    initial: { scale: 0.7, opacity: 0.5 },
    animate: { scale: 1, opacity: 1, transition: { type: 'spring', stiffness: 300, damping: 20 } },
    whileHover: { scale: 1.1 },
    whileTap: { scale: 0.9 }
  }}
/>
```

## No Animation

```tsx
<Toggle checked={checked} onChange={setChecked} animation={{ transition: { duration: 0 } }} />
```

## ToggleTheme Interface

```typescript
interface ToggleTheme {
  base: string;                // Track styles (flex, rounded-full, bg, border)
  disabled: string;            // Disabled track
  checked: string;             // Checked track (justify-end, bg change)
  disabledAndChecked: string;  // Disabled + checked track
  handle: {
    base: string;              // Handle styles (rounded-full, bg)
    sizes: { small, medium, large };
    disabled: string;
    disabledAndChecked: string;
  };
  sizes: { small, medium, large };  // Track dimensions per size
}
```
