# Drawer

Slide-in side panel with backdrop, focus trapping, position variants, and slot-based content. Built on GlobalOverlay and Framer Motion. Also exports `useDrawer` hook.

## Import

```tsx
import { Drawer, DrawerHeader, DrawerContent, DrawerFooter, useDrawer } from 'reablocks';
```

## Drawer Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `open` | `boolean` | — | Whether the drawer is visible |
| `onClose` | `() => void` | — | Close handler |
| `position` | `'start' \| 'end' \| 'top' \| 'bottom'` | `'end'` | Slide-in direction |
| `size` | `string \| number` | `'80%'` | Drawer width (start/end) or height (top/bottom) |
| `header` | `ReactNode` | — | *(deprecated)* Header — use `<DrawerHeader>` slot |
| `showCloseButton` | `boolean` | `true` | Show close button |
| `disablePadding` | `boolean` | `false` | Remove content padding |
| `hasBackdrop` | `boolean` | `true` | Show backdrop overlay |
| `closeOnBackdropClick` | `boolean` | `true` | Close on backdrop click |
| `closeOnEscape` | `boolean` | `true` | Close on Escape key |
| `animation` | `MotionNodeAnimationOptions` | — | Custom animation config |
| `className` | `string` | — | Drawer panel CSS classes |
| `contentClassName` | `string` | — | Content area CSS classes |
| `backdropClassName` | `string` | — | Backdrop CSS classes |
| `theme` | `DrawerTheme` | — | Per-instance theme override |
| `children` | `ReactNode` | — | Content (supports slots) |

## Slot-Based Usage (Recommended)

```tsx
<Drawer open={isOpen} onClose={close} position="end" size="400px">
  <DrawerHeader>Settings</DrawerHeader>
  <DrawerContent>
    <p>Drawer body content here.</p>
  </DrawerContent>
  <DrawerFooter>
    <Button onClick={save} color="primary">Save</Button>
  </DrawerFooter>
</Drawer>
```

## Positions

```tsx
<Drawer position="end" ...>   {/* Slides from right (default) */}
<Drawer position="start" ...> {/* Slides from left */}
<Drawer position="top" ...>   {/* Slides from top */}
<Drawer position="bottom" ...>{/* Slides from bottom */}
```

Slide animations per position: start = `x: -100% → 0%`, end = `x: 100% → 0%`, top = `y: -100% → 0%`, bottom = `y: 100% → 0%`.

## useDrawer Hook

```tsx
const { isOpen, setOpen, toggleOpen, Drawer: DrawerComponent } = useDrawer();

<Button onClick={() => setOpen(true)}>Open</Button>
<DrawerComponent size="400px">
  <DrawerHeader>Title</DrawerHeader>
  <DrawerContent>Content</DrawerContent>
</DrawerComponent>
```

### Hook Returns

| Property | Type | Description |
|----------|------|-------------|
| `isOpen` | `boolean` | Current open state |
| `setOpen` | `(open: boolean) => void` | Set open state |
| `toggleOpen` | `() => void` | Toggle open state |
| `Drawer` | `FC<Partial<DrawerProps>>` | Pre-wired Drawer component |

## DrawerTheme Interface

```typescript
interface DrawerTheme {
  base: string;       // Fixed panel (fixed, overflow-y-auto, bg)
  header: { base: string; text: string };
  content: string;    // Content area (padding)
  footer: string;     // Footer area
  disablePadding: string;
  closeButton: { base: string; headerless: string };
  positions: {
    top: string;      // w-full, inset-x-0, top-0
    end: string;      // h-full, inset-y-0, right-0
    bottom: string;   // w-full, inset-x-0, bottom-0
    start: string;    // h-full, inset-y-0, left-0
  };
}
```
