# Motion

Animation wrapper components using Framer Motion for staggered group animations. Provides MotionGroup (parent) and MotionItem (child) with pre-configured variants.

## Import

```tsx
import { MotionGroup, MotionItem } from 'reablocks';
```

## MotionGroup

Container that staggers children animations.

### MotionGroup Props

Extends Framer Motion `HTMLMotionProps<'div'>`, plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | — | MotionItem children |

Pre-configured variants: stagger children 0.07s delay, 0.2s initial delay.

## MotionItem

Individual animated item within a MotionGroup.

### MotionItem Props

Extends Framer Motion `HTMLMotionProps<'div'>`, plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `direction` | `'horizontal' \| 'vertical'` | `'vertical'` | Animation direction |
| `children` | `ReactNode` | — | Content |

- **vertical**: Animates y: -20→0 with opacity 0→1
- **horizontal**: Animates x: -100%→0% with opacity 0→1

## Basic Usage

```tsx
<MotionGroup>
  <MotionItem>First item</MotionItem>
  <MotionItem>Second item (staggered)</MotionItem>
  <MotionItem>Third item (staggered)</MotionItem>
</MotionGroup>
```

## Horizontal Animation

```tsx
<MotionGroup>
  <MotionItem direction="horizontal">Slides in from left</MotionItem>
</MotionGroup>
```
