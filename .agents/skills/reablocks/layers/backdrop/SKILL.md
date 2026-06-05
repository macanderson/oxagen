# Backdrop

Animated overlay backdrop for modals, dialogs, and drawers. Fades in/out with Framer Motion. Typically used internally by Dialog and Drawer.

## Import

```tsx
import { Backdrop } from 'reablocks';
```

## Backdrop Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `zIndex` | `number` | `998` | CSS z-index |
| `portalIndex` | `number` | `0` | Portal nesting index (reduces opacity for stacked backdrops) |
| `className` | `string` | — | Additional CSS classes |
| `onClick` | `(event: MouseEvent) => void` | — | Click handler (used for close-on-backdrop-click) |
| `theme` | `BackdropTheme` | — | Per-instance theme override |

## BackdropTheme Interface

```typescript
interface BackdropTheme {
  base: string;    // Fixed full-screen overlay (fixed, top-0, left-0, w-full, h-full, bg-black)
  opacity: number; // Target opacity (default: 0.8)
}
```
