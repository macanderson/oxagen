# DotsLoader

Animated loading indicator with three pulsing dots. Each dot animates opacity and scale with staggered timing using Framer Motion.

## Import

```tsx
import { DotsLoader } from 'reablocks';
```

## DotsLoader Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Dot size variant |
| `speed` | `number` | `0.2` | Animation speed (lower = faster) |
| `className` | `string` | — | Additional CSS classes |
| `theme` | `DotsLoaderTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<DotsLoader />
```

## Sizes

```tsx
<DotsLoader size="small" />
<DotsLoader size="medium" />
<DotsLoader size="large" />
```

Dot dimensions: small = `w-1 h-1`, medium = `w-1.5 h-1.5`, large = `w-2 h-2`.

## Custom Speed

```tsx
<DotsLoader speed={0.1} />  {/* Faster */}
<DotsLoader speed={0.5} />  {/* Slower */}
```

## DotsLoaderTheme Interface

```typescript
interface DotsLoaderTheme {
  base: string;    // Container (flex)
  dot: string;     // Dot element (rounded, color)
  sizes: {
    small: string;
    medium: string;
    large: string;
    [key: string]: string;
  };
}
```
