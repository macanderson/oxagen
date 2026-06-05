# Kbd

Displays keyboard shortcuts with platform-aware modifier key symbols. Splits key combinations by `+` and renders each key as a styled Chip inside a `<kbd>` element.

## Import

```tsx
import { Kbd } from 'reablocks';
```

## Kbd Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `keycode` | `string` | — | Keyboard shortcut string (e.g. `"mod+shift+k"`) |
| `theme` | `KbdTheme` | — | Per-instance theme override |

Also inherits Chip props (except `children` and `theme`): `size`, `color`, `variant`, etc.

## Basic Usage

```tsx
<Kbd keycode="mod+shift+k" />
```

Renders as: `⌘` `⇧` `k` (on Mac) or `CTRL` `⇧` `k` (on Windows/Linux)

## Key Transformations

The `getHotkeyText` utility performs these string replacements (keys are **not** auto-uppercased):

| Input | Mac Output | Windows/Linux Output |
|-------|------------|---------------------|
| `mod`, `modifier`, `meta` | `⌘` | `CTRL` |
| `shift` | `⇧` | `⇧` |
| `plus` | `+` | `+` |
| `minus` | `-` | `-` |
| Other keys | As-is | As-is |

## Examples

```tsx
<Kbd keycode="mod+c" />         {/* ⌘ c  or  CTRL c */}
<Kbd keycode="mod+shift+p" />   {/* ⌘ ⇧ p  or  CTRL ⇧ p */}
<Kbd keycode="mod+plus" />      {/* ⌘ +  or  CTRL + */}
```

## KbdTheme Interface

```typescript
interface KbdTheme {
  base: string;   // Container (inline-flex, gap, alignment)
  chip: string;   // Individual key chip (font-mono, rounded)
}
```
