# Dialog

Modal dialog with backdrop, focus trapping, animated entrance/exit, and slot-based content. Built on GlobalOverlay and Framer Motion. Also exports `useDialog` hook.

## Import

```tsx
import { Dialog, DialogHeader, DialogContent, DialogFooter, useDialog } from 'reablocks';
```

## Dialog Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `open` | `boolean` | — | Whether the dialog is visible |
| `onClose` | `() => void` | — | Close handler |
| `size` | `string \| number` | `'50%'` | Dialog width |
| `header` | `ReactNode` | — | *(deprecated)* Header content — use `<DialogHeader>` slot |
| `footer` | `ReactNode` | — | *(deprecated)* Footer content — use `<DialogFooter>` slot |
| `showCloseButton` | `boolean` | `true` | Show close button in header |
| `disablePadding` | `boolean` | `false` | Remove content padding |
| `hasBackdrop` | `boolean` | `true` | Show backdrop overlay |
| `closeOnBackdropClick` | `boolean` | `true` | Close when clicking backdrop |
| `closeOnEscape` | `boolean` | `true` | Close on Escape key |
| `animation` | `MotionNodeAnimationOptions` | — | Custom animation config |
| `className` | `string` | — | Root element CSS classes |
| `innerClassName` | `string` | — | Inner container CSS classes |
| `contentClassName` | `string` | — | Content section CSS classes |
| `theme` | `DialogTheme` | — | Per-instance theme override |
| `children` | `ReactNode \| (() => ReactNode)` | — | Dialog body (supports slots or render function) |

## Slot-Based Usage (Recommended)

```tsx
<Dialog open={isOpen} onClose={close}>
  <DialogHeader>My Title</DialogHeader>
  <DialogContent>
    <p>Dialog body content here.</p>
  </DialogContent>
  <DialogFooter>
    <Button onClick={save} color="primary">Save</Button>
    <Button onClick={close}>Cancel</Button>
  </DialogFooter>
</Dialog>
```

## Legacy Props Usage

```tsx
<Dialog open={isOpen} onClose={close} header="My Title">
  {() => (
    <div>Dialog body content here.</div>
  )}
</Dialog>
```

## useDialog Hook

```tsx
const { isOpen, setOpen, toggleOpen, Dialog: DialogComponent } = useDialog();

<Button onClick={() => setOpen(true)}>Open</Button>
<DialogComponent size="600px">
  <DialogHeader>Title</DialogHeader>
  <DialogContent>Content</DialogContent>
</DialogComponent>
```

### Hook Returns

| Property | Type | Description |
|----------|------|-------------|
| `isOpen` | `boolean` | Current open state |
| `setOpen` | `(open: boolean) => void` | Set open state |
| `toggleOpen` | `() => void` | Toggle open state |
| `Dialog` | `FC<Partial<DialogProps>>` | Pre-wired Dialog component |

## DialogTheme Interface

```typescript
interface DialogTheme {
  base: string;    // Overlay container (fixed, flex, centered)
  inner: string;   // Dialog box (flex-col, bg, border, rounded, shadow, max-w/h)
  content: string; // Content area (padding, flex-auto, overflow)
  footer: string;  // Footer area (flex, padding)
  header: {
    base: string;       // Header container (flex, justify-between, padding)
    text: string;       // Title text (flex-1, font-bold)
    closeButton: string; // Close button (cursor-pointer, text-size)
  };
}
```
