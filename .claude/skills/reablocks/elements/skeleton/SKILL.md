# Skeleton

Placeholder loading skeleton for content areas. Supports predefined shape variants and an optional shimmer animation.

## Import

```tsx
import { Skeleton } from 'reablocks';
```

## Skeleton Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'text' \| 'rounded' \| 'rectangle' \| 'square' \| string` | — | Predefined shape variant |
| `animated` | `boolean` | `false` | Enable shimmer pulse animation |
| `theme` | `SkeletonTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |
| `style` | `CSSProperties` | — | Inline styles |

Also accepts all standard `HTMLDivElement` attributes. Renders with `aria-busy="true"` and `aria-live="polite"`.

## Variants

```tsx
<Skeleton variant="text" />        {/* h-4 w-full — single text line */}
<Skeleton variant="rounded" />     {/* w-10 h-10 rounded-full — avatar circle */}
<Skeleton variant="rectangle" />   {/* h-24 w-full — wide rectangle */}
<Skeleton variant="square" />      {/* w-24 h-24 — square */}
```

## Animated

```tsx
<Skeleton variant="text" animated />
<Skeleton variant="rounded" animated />
```

## Custom Sizes

Use `className` or `style` for custom dimensions:

```tsx
<Skeleton className="h-2.5 w-48" animated />
<Skeleton className="h-10 w-full" animated />
<Skeleton style={{ width: 300, height: 200 }} animated />
```

## Card Placeholder Example

```tsx
<div className="flex items-center gap-4">
  <Skeleton variant="rounded" animated />
  <div className="flex-1 flex flex-col gap-2">
    <Skeleton className="h-4 w-1/3" animated />
    <Skeleton className="h-3 w-full" animated />
    <Skeleton className="h-3 w-4/5" animated />
  </div>
</div>
```

## Multiple Lines

```tsx
<div className="flex flex-col gap-2 w-64">
  <Skeleton className="h-4 w-full" animated />
  <Skeleton className="h-4 w-[90%]" animated />
  <Skeleton className="h-4 w-[80%]" animated />
  <Skeleton className="h-4 w-[70%]" animated />
  <Skeleton className="h-4 w-[60%]" animated />
</div>
```

## SkeletonTheme Interface

```typescript
interface SkeletonTheme {
  base: string;       // Base styles (rounded, bg color)
  animated: string;   // Shimmer animation (pulse gradient)
  variants: {
    text: string;
    rounded: string;
    rectangle: string;
    square: string;
    [key: string]: string;
  };
}
```
