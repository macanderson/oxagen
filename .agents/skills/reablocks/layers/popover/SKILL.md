# Popover

Content popover anchored to an element. Built on Tooltip with focus trapping and click trigger. Supports all Tooltip positioning options.

## Import

```tsx
import { Popover } from 'reablocks';
```

## Popover Props

Extends Tooltip props (except `theme`), plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `disablePadding` | `boolean` | — | Remove default padding |
| `popoverStyle` | `CSSProperties` | — | Inline styles for popover content |
| `popoverClassName` | `string` | — | CSS classes for popover content |
| `autoFocus` | `FocusTargetOrFalse` | — | Initial focus target (or `false` for none) |
| `theme` | `PopoverTheme` | — | Per-instance theme override |

Key inherited props from Tooltip:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `ReactNode \| (() => ReactNode)` | — | Popover content |
| `placement` | `Placement` | `'top'` | Floating UI placement |
| `trigger` | `TriggerTypes` | `'click'` | How to open (click by default) |
| `closeOnEscape` | `boolean` | `true` | Close on Escape key |
| `closeOnBodyClick` | `boolean` | `true` | Close on outside click |
| `leaveDelay` | `number` | `200` | Delay before closing (ms) |
| `className` | `string` | — | Tooltip wrapper CSS classes |

## Basic Usage

```tsx
<Popover content="Popover content here">
  <Button>Click me</Button>
</Popover>
```

## Rich Content

```tsx
<Popover content={() => (
  <Card>
    <h3>Popover Title</h3>
    <p>Some detailed content...</p>
    <Button size="small">Action</Button>
  </Card>
)}>
  <Button>Open Popover</Button>
</Popover>
```

## PopoverTheme Interface

```typescript
interface PopoverTheme {
  base: string;           // Base styles (whitespace, text-center, padding, rounded, bg)
  disablePadding: string; // No padding override
}
```
