# Collapse

Expandable/collapsible content panel with animated height transition. Uses Framer Motion AnimatePresence for smooth open/close.

## Import

```tsx
import { Collapse } from 'reablocks';
```

## Collapse Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `expanded` | `boolean` | — | Whether the content is visible |
| `animated` | `boolean` | `true` | *(deprecated)* Enable animation |
| `animation` | `MotionNodeAnimationOptions` | — | Custom animation config |
| `className` | `string` | — | Additional CSS classes |
| `theme` | `CollapseTheme` | — | Per-instance theme override |
| `children` | `ReactNode \| (() => ReactNode)` | — | Content (supports render function) |

## Basic Usage

```tsx
const [expanded, setExpanded] = useState(false);

<Button onClick={() => setExpanded(!expanded)}>Toggle</Button>
<Collapse expanded={expanded}>
  <p>Collapsible content here</p>
</Collapse>
```

## With Render Function

```tsx
<Collapse expanded={expanded}>
  {() => <ExpensiveComponent />}
</Collapse>
```

Content is only rendered when expanded (unmounted when collapsed via AnimatePresence).

Default animation: opacity 0→1 + height 0→auto with 0.5s ease transition.

## CollapseTheme Interface

```typescript
interface CollapseTheme {
  base: string;  // Container (will-change-[height,opacity], overflow-hidden)
}
```
