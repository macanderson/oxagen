# Chip

Compact element for tags, filters, labels, or selections. Supports colors, variants, sizes, adornments, and interactive states (clickable, selectable). Uses `forwardRef` and keyboard accessibility (Enter/Space).

## Import

```tsx
import { Chip } from 'reablocks';
```

## Chip Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `color` | `'default' \| 'primary' \| 'secondary' \| 'success' \| 'warning' \| 'error' \| 'info' \| string` | `'default'` | Color variant |
| `variant` | `'filled' \| 'outline' \| 'subtle' \| string` | `'filled'` | Style variant |
| `size` | `'small' \| 'medium' \| 'large' \| string` | `'medium'` | Size variant |
| `selected` | `boolean` | — | Whether the chip is selected (applies selected styles) |
| `disabled` | `boolean` | — | Whether the chip is disabled |
| `disableMargins` | `boolean` | — | Remove default margins |
| `start` | `ReactElement \| string` | — | Content before the label |
| `end` | `ReactElement \| string` | — | Content after the label |
| `theme` | `ChipTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |

Also accepts all standard `HTMLDivElement` attributes including `onClick`.

## Basic Usage

```tsx
<Chip color="primary">Label</Chip>
```

## Variants

```tsx
<Chip variant="filled">Filled</Chip>
<Chip variant="outline">Outline</Chip>
<Chip variant="subtle">Subtle</Chip>
```

## Colors

All 7 colors work with every variant:

```tsx
<Chip color="default">Default</Chip>
<Chip color="primary">Primary</Chip>
<Chip color="secondary">Secondary</Chip>
<Chip color="success">Success</Chip>
<Chip color="warning">Warning</Chip>
<Chip color="error">Error</Chip>
<Chip color="info">Info</Chip>
```

## Sizes

```tsx
<Chip size="small">Small</Chip>
<Chip size="medium">Medium</Chip>
<Chip size="large">Large</Chip>
```

## Adornments

Use `start` and `end` to add icons or text before/after the label:

```tsx
<Chip start={<StarIcon />}>With Icon</Chip>
<Chip end={<ArrowIcon />}>With End</Chip>
<Chip start="$" end={<CloseIcon />}>Both</Chip>
```

## Clickable

When `onClick` is provided, the chip becomes a button with `role="button"`, `tabIndex={0}`, and keyboard support:

```tsx
<Chip variant="outline" onClick={() => handleClick()}>
  Clickable
</Chip>
```

Selectable hover styles (`selectable` in theme) are automatically applied when `onClick` is present.

## Selected State

```tsx
<Chip
  variant="outline"
  color="primary"
  selected={isSelected}
  onClick={() => setIsSelected(!isSelected)}
>
  Toggle Me
</Chip>
```

## Deletable

Use an IconButton in the `end` slot for close/delete:

```tsx
import { Chip, IconButton } from 'reablocks';
import CloseIcon from './close.svg?react';

<Chip
  variant="filled"
  color="success"
  end={
    <IconButton size="small" variant="text" onClick={() => onDelete()}>
      <CloseIcon />
    </IconButton>
  }
>
  Removable
</Chip>
```

## ChipTheme Interface

```typescript
interface ChipTheme {
  base: string;              // Base styles (inline-flex, rounded, transitions)
  label?: string;            // Label wrapper styles
  disabled: string;          // Disabled state (opacity, cursor)
  adornment: {
    base: string;            // Adornment container
    start: string;           // Start adornment spacing
    end: string;             // End adornment spacing
    sizes: {                 // Icon sizing per chip size
      small: string;
      medium: string;
      large: string;
    };
  };
  variants: {                // Per-variant base classes
    filled?: string;
    outline?: string;
    subtle?: string;
    [key: string]: string;
  };
  colors: {                  // Per-color, per-variant classes
    [colorName: string]: {
      base?: string;         // Color base (applied to all variants)
      variants?: {
        [variantName: string]: {
          base: string;      // Base styles for this color+variant
          selected?: string; // Selected state styles
          selectable?: string; // Hover styles when clickable
          start?: string;    // Start adornment color
          end?: string;      // End adornment color
        };
      };
    };
  };
  sizes: {                   // Per-size classes
    small: string;
    medium: string;
    large: string;
    [key: string]: string;
  };
  closeButton: {             // Close button styles (used by IconButton in end slot)
    base: string;
    sizes: { small, medium, large };
  };
}
```
