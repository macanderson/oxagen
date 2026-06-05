# Tooltip

Hover tooltip with Floating UI positioning, animated entrance/exit, enter/leave delays, and follow-cursor mode. Global state ensures only one tooltip is visible at a time.

## Import

```tsx
import { Tooltip } from 'reablocks';
```

## Tooltip Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `ReactNode \| (() => ReactNode)` | — | Tooltip content |
| `children` | `ReactNode` | — | Trigger element |
| `placement` | `Placement` | `'top'` | Floating UI placement |
| `trigger` | `TriggerTypes \| TriggerTypes[]` | `'hover'` | Trigger type(s) |
| `enterDelay` | `number` | `0` | Delay before showing (ms) |
| `leaveDelay` | `number` | `200` | Delay before hiding (ms) |
| `visible` | `boolean` | `false` | External visibility control |
| `disabled` | `boolean` | `false` | Disable the tooltip |
| `followCursor` | `boolean` | `false` | Follow mouse cursor |
| `closeOnClick` | `boolean` | `false` | Close on content click |
| `closeOnBodyClick` | `boolean` | `true` | Close on outside click |
| `closeOnEscape` | `boolean` | `true` | Close on Escape key |
| `animated` | `boolean` | `true` | *(deprecated)* Enable animation |
| `animation` | `MotionNodeAnimationOptions` | — | Custom animation config |
| `className` | `string` | — | Tooltip content CSS classes |
| `triggerClassName` | `string` | — | Trigger wrapper CSS classes |
| `reference` | `HTMLElement \| ReferenceObject` | — | External reference element |
| `modifiers` | `Modifiers` | — | Floating UI middleware |
| `onOpen` | `() => void` | — | Open callback |
| `onClose` | `() => void` | — | Close callback |
| `theme` | `TooltipTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<Tooltip content="Helpful tip">
  <Button>Hover me</Button>
</Tooltip>
```

## Placement

```tsx
<Tooltip content="Top" placement="top">...</Tooltip>
<Tooltip content="Bottom" placement="bottom">...</Tooltip>
<Tooltip content="Left" placement="left">...</Tooltip>
<Tooltip content="Right" placement="right">...</Tooltip>
```

## With Delay

```tsx
<Tooltip content="Delayed tooltip" enterDelay={500} leaveDelay={100}>
  <span>Hover me</span>
</Tooltip>
```

## Follow Cursor

```tsx
<Tooltip content="Following..." followCursor>
  <div className="w-64 h-32 bg-gray-200">Move mouse here</div>
</Tooltip>
```

## Rich Content

```tsx
<Tooltip content={() => (
  <div>
    <strong>Title</strong>
    <p>Detailed description</p>
  </div>
)}>
  <span>Hover for details</span>
</Tooltip>
```

## TooltipTheme Interface

```typescript
interface TooltipTheme {
  base: string;           // Tooltip styles (whitespace, text-center, padding, rounded, bg, text)
  disablePointer: string; // Pointer-events-none (applied to portal when pointerEvents='none')
}
```
