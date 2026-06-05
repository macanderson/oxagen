# Badge

Small status indicator or count label positioned relative to its child element. Animated on appearance using Framer Motion.

## Import

```tsx
import { Badge } from 'reablocks';
```

## Badge Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `string \| JSX.Element` | — | Badge content (text or element) |
| `color` | `'default' \| 'primary' \| 'secondary' \| 'error' \| string` | `'default'` | Color variant |
| `placement` | `'top-start' \| 'top-end' \| 'bottom-start' \| 'bottom-end'` | `'top-end'` | Badge position relative to child |
| `hidden` | `boolean` | `false` | Hide the badge |
| `disableMargins` | `boolean` | `false` | Remove default margins |
| `theme` | `BadgeTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |

Also accepts all standard `HTMLSpanElement` attributes.

## Basic Usage

```tsx
<Badge content="3" color="primary">
  <NotificationIcon />
</Badge>
```

## Colors

```tsx
<Badge content="1" color="default"><Icon /></Badge>
<Badge content="2" color="primary"><Icon /></Badge>
<Badge content="3" color="secondary"><Icon /></Badge>
<Badge content="4" color="error"><Icon /></Badge>
```

## Placement

```tsx
<Badge content="1" placement="top-start"><Icon /></Badge>
<Badge content="2" placement="top-end"><Icon /></Badge>
<Badge content="3" placement="bottom-start"><Icon /></Badge>
<Badge content="4" placement="bottom-end"><Icon /></Badge>
```

## Hidden Badge

```tsx
<Badge content="5" hidden>
  <Icon />
</Badge>
```

## Content-Only Badge (No Children)

```tsx
<Badge content="7" color="error" />
```

## BadgeTheme Interface

```typescript
interface BadgeTheme {
  base: string;              // Container (relative, inline-flex)
  disableMargins: string;    // No margin override
  badge: string;             // Badge element (absolute, centered, rounded)
  position: string;          // Default position transform
  colors: {
    default: string;
    primary: string;
    secondary: string;
    error: string;
    [key: string]: string;
  };
  positions: {
    'top-start': string;
    'top-end': string;
    'bottom-start': string;
    'bottom-end': string;
  };
}
```
