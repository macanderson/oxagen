# Menu

Dropdown menu positioned via ConnectedOverlay (Floating UI). Supports focus trapping, auto-width matching, and animated entrance/exit.

## Import

```tsx
import { Menu } from 'reablocks';
```

## Menu Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `open` | `boolean` | `false` | Whether the menu is visible |
| `reference` | `any` | — | Reference element for positioning |
| `children` | `ReactNode \| (() => ReactNode)` | — | Menu content |
| `placement` | `Placement` | `'bottom-start'` | Floating UI placement |
| `appendToBody` | `boolean` | `true` | Portal to body |
| `closeOnBodyClick` | `boolean` | `true` | Close on outside click |
| `closeOnEscape` | `boolean` | `true` | Close on Escape key |
| `autofocus` | `boolean` | `true` | Focus trap on open |
| `autoWidth` | `boolean` | — | Match reference element width |
| `minWidth` | `number` | — | Minimum menu width |
| `maxWidth` | `number` | — | Maximum menu width |
| `maxHeight` | `string` | `'calc(100vh - 48px)'` | Maximum menu height |
| `animated` | `boolean` | `true` | *(deprecated)* Enable animation |
| `animation` | `MotionNodeAnimationOptions` | — | Custom animation config |
| `modifiers` | `Modifiers` | — | Floating UI middleware |
| `className` | `string` | — | Menu container CSS classes |
| `style` | `CSSProperties` | — | Inline styles |
| `onClose` | `(event: OverlayEvent) => void` | — | Close handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |
| `theme` | `MenuTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
const ref = useRef();
const [open, setOpen] = useState(false);

<Button ref={ref} onClick={() => setOpen(!open)}>Open Menu</Button>
<Menu open={open} reference={ref} onClose={() => setOpen(false)}>
  <List>
    <ListItem onClick={() => action1()}>Item 1</ListItem>
    <ListItem onClick={() => action2()}>Item 2</ListItem>
    <ListItem onClick={() => action3()}>Item 3</ListItem>
  </List>
</Menu>
```

## Auto Width

Match menu width to reference element:

```tsx
<Menu open={open} reference={ref} autoWidth onClose={close}>
  {() => <List>...</List>}
</Menu>
```

## MenuTheme Interface

```typescript
interface MenuTheme {
  base: string;   // Outer container (relative, min-w, max-w, padding)
  inner: string;  // Inner container (focus:outline-hidden, bg, text)
}
```
