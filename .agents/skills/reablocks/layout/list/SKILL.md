# List

Structured list display with items, headers, adornments, and interactive states. Composed of List, ListItem, and ListHeader.

## Import

```tsx
import { List, ListItem, ListHeader } from 'reablocks';
```

## List Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `className` | `string` | — | Additional CSS classes |
| `theme` | `ListTheme` | — | Per-instance theme override |

Renders as `<div role="list">`. Uses `forwardRef`.

## ListItem Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `active` | `boolean` | — | Active/selected state |
| `disabled` | `boolean` | — | Disabled state |
| `dense` | `boolean` | — | Reduced padding |
| `disablePadding` | `boolean` | — | Remove padding |
| `disableGutters` | `boolean` | — | Remove left/right padding |
| `start` | `ReactNode` | — | Start adornment (icon) |
| `end` | `ReactNode` | — | End adornment (icon/badge) |
| `contentClassName` | `string` | — | Content area CSS classes |
| `className` | `string` | — | Item CSS classes |
| `onClick` | handler | — | Makes item clickable |
| `theme` | `ListTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<List>
  <ListHeader>Section Title</ListHeader>
  <ListItem>Item 1</ListItem>
  <ListItem>Item 2</ListItem>
  <ListItem>Item 3</ListItem>
</List>
```

## With Adornments

```tsx
<List>
  <ListItem start={<UserIcon />} end={<Badge content="3" />}>
    Messages
  </ListItem>
  <ListItem start={<SettingsIcon />}>
    Settings
  </ListItem>
</List>
```

## Interactive

```tsx
<List>
  <ListItem active onClick={() => navigate('/home')}>Home</ListItem>
  <ListItem onClick={() => navigate('/about')}>About</ListItem>
  <ListItem disabled>Disabled</ListItem>
</List>
```

## ListTheme Interface

```typescript
interface ListTheme {
  base: string;       // Container (flex-col)
  header: string;     // Header styles
  listItem: {
    base: string;     // Item (flex, padding, rounded, hover)
    disabled: string;
    active: string;
    clickable: string;
    disablePadding: string;
    disableGutters: string;
    dense: { base, content, start, end };
    adornment: { base, start, end, svg };
    content: string;
  };
}
```
