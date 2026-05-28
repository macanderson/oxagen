# Avatar

Displays a user avatar with image, auto-generated initials, or icon fallback. Supports color generation, variants, and click interaction.

## Import

```tsx
import { Avatar, AvatarGroup } from 'reablocks';
```

## Avatar Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | `string` | — | Person's name (used for initials and color generation) |
| `src` | `string` | — | Image URL for the avatar |
| `size` | `number` | `24` | Avatar size in pixels |
| `variant` | `'filled' \| 'outline'` | `'filled'` | Style variant |
| `rounded` | `boolean` | `true` | Whether the avatar is circular |
| `color` | `string` | — | Color override (auto-generated from name if omitted) |
| `colorOptions` | `{ saturation, lightness, alpha }` | — | Options for auto color generation |
| `theme` | `AvatarTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |

Also accepts all standard `HTMLDivElement` attributes including `onClick`.

## Basic Usage

```tsx
<Avatar name="John Doe" size={50} />
```

## With Image

```tsx
<Avatar name="John Doe" src="/path/to/photo.jpg" size={50} rounded />
```

## Variants

```tsx
{/* Solid background with white initials */}
<Avatar name="John Doe" size={50} variant="filled" />

{/* Transparent background with colored border */}
<Avatar name="John Doe" size={50} variant="outline" />
```

## Square Avatar

```tsx
<Avatar name="John Doe" size={50} rounded={false} />
```

## Clickable

When `onClick` is provided, clickable theme styles are applied:

```tsx
<Avatar name="John Doe" size={50} onClick={() => console.log('clicked')} />
```

## AvatarTheme Interface

```typescript
interface AvatarTheme {
  base: string;       // Base styles (flex, alignment, font)
  clickable: string;  // Styles when onClick is present
  rounded: string;    // Rounded corner styles
}
```

---

# AvatarGroup

Displays multiple avatars in an overlapping stack with an overflow indicator.

## AvatarGroup Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | — | Avatar elements to display |
| `size` | `number` | `10` | Maximum number of visible avatars |
| `theme` | `AvatarGroupTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |

## AvatarGroup Usage

```tsx
<AvatarGroup size={5}>
  <Avatar name="John Doe" src="/photo1.jpg" size={32} />
  <Avatar name="Jane Smith" src="/photo2.jpg" size={32} />
  <Avatar name="Bob Wilson" size={32} />
  <Avatar name="Alice Brown" size={32} />
  <Avatar name="Charlie Davis" size={32} />
  <Avatar name="Diana Evans" size={32} />
  <Avatar name="Frank Green" size={32} />
</AvatarGroup>
```

When avatars exceed `size`, a "+N more" indicator is displayed.

## AvatarGroupTheme Interface

```typescript
interface AvatarGroupTheme {
  base: string;      // Container styles (flex, alignment)
  avatar: string;    // Individual avatar wrapper (negative margin for overlap)
  overflow: string;  // Overflow indicator styles
}
```
