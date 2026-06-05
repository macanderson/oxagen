# Divider

Visual separator line. Renders as `<hr>`. Supports horizontal/vertical orientation and variant colors.

## Import

```tsx
import { Divider } from 'reablocks';
```

## Divider Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `orientation` | `'horizontal' \| 'vertical'` | `'horizontal'` | Divider direction |
| `variant` | `'primary' \| 'secondary'` | `'primary'` | Color variant |
| `disableMargins` | `boolean` | `false` | Remove default margins |
| `className` | `string` | — | Additional CSS classes |
| `style` | `CSSProperties` | — | Inline styles |
| `theme` | `DividerTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<Divider />
```

## Vertical

```tsx
<div className="flex h-16 items-center gap-4">
  <span>Left</span>
  <Divider orientation="vertical" />
  <span>Right</span>
</div>
```

## Variants

```tsx
<Divider variant="primary" />   {/* Solid bg-surface */}
<Divider variant="secondary" /> {/* Gradient via-blue-500 */}
```

## DividerTheme Interface

```typescript
interface DividerTheme {
  base: string;           // Base (border-none)
  orientation: {
    horizontal: string;   // h-px, w-full, my-2.5
    vertical: string;     // w-px, h-full, mx-2.5
  };
  variant: {
    primary: string;      // Solid color
    secondary: string;    // Gradient
  };
  disableMargins: string; // No margins
}
```
