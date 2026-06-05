# IconButton

A button optimized for icon-only actions. Wraps the Button component with square padding and removes `fullWidth`, `start`, and `end` props.

## Import

```tsx
import { IconButton } from 'reablocks';
```

## IconButton Props

Inherits all Button props except `fullWidth`, `start`, and `end`:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `color` | `'default' \| 'primary' \| 'secondary' \| 'destructive' \| string` | `'default'` | Color variation |
| `variant` | `'filled' \| 'outline' \| 'text' \| 'ghost' \| string` | `'filled'` | Style variant |
| `size` | `'small' \| 'medium' \| 'large' \| string` | `'medium'` | Size variation |
| `disabled` | `boolean` | `false` | Disable the button |
| `animated` | `boolean` | `true` | Enable press animation |
| `theme` | `ButtonTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |
| `children` | `ReactNode` | — | Icon element |

## Basic Usage

```tsx
<IconButton color="primary">
  <SearchIcon />
</IconButton>
```

## Variants

```tsx
<IconButton variant="filled"><Icon /></IconButton>
<IconButton variant="outline"><Icon /></IconButton>
<IconButton variant="text"><Icon /></IconButton>
<IconButton variant="ghost"><Icon /></IconButton>
```

## Colors

```tsx
<IconButton color="primary" variant="filled"><Icon /></IconButton>
<IconButton color="secondary" variant="filled"><Icon /></IconButton>
<IconButton color="destructive" variant="filled"><Icon /></IconButton>

<IconButton color="primary" variant="outline"><Icon /></IconButton>
<IconButton color="primary" variant="text"><Icon /></IconButton>
<IconButton color="primary" variant="ghost"><Icon /></IconButton>
```

## Sizes

Icon padding per size: small = `px-2 py-1`, medium = `px-4 py-2`, large = `px-5 py-2.5`:

```tsx
<IconButton size="small"><Icon /></IconButton>
<IconButton size="medium"><Icon /></IconButton>
<IconButton size="large"><Icon /></IconButton>
```

## Disabled

```tsx
<IconButton disabled variant="filled"><Icon /></IconButton>
<IconButton disabled variant="outline"><Icon /></IconButton>
```

## Theme

Uses the Button theme. Icon-specific padding is applied from `theme.iconSizes[size]`:

```typescript
// Default iconSizes in ButtonTheme
iconSizes: {
  small: 'px-2 py-1',
  medium: 'px-4 py-2',
  large: 'px-5 py-2.5'
}
```
