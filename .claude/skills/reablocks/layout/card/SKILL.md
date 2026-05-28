# Card

Content container with optional header section. Renders as a `<section>` with border, background, rounded corners, and padding.

## Import

```tsx
import { Card } from 'reablocks';
```

## Card Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `header` | `string \| JSX.Element \| JSX.Element[]` | — | Header content (string renders as `<h3>`) |
| `disablePadding` | `boolean` | — | Remove padding |
| `className` | `string` | — | Card container CSS classes |
| `headerClassName` | `string` | — | Header CSS classes |
| `contentClassName` | `string` | — | Content area CSS classes |
| `style` | `CSSProperties` | — | Inline styles |
| `theme` | `CardTheme` | — | Per-instance theme override |

Also accepts DOM event attributes. Uses `forwardRef`.

## Basic Usage

```tsx
<Card>Card content here</Card>
```

## With Header

```tsx
<Card header="Settings">
  <p>Card body content</p>
</Card>
```

## With Custom Header

```tsx
<Card header={<div className="flex justify-between"><h3>Title</h3><Button>Action</Button></div>}>
  Content
</Card>
```

## No Padding

```tsx
<Card disablePadding>
  <List>...</List>
</Card>
```

## CardTheme Interface

```typescript
interface CardTheme {
  base: string;           // Container (flex-col, padding, rounded, bg, border)
  disablePadding: string; // No padding override
  header: string;         // Header container (flex, items-center)
  headerText: string;     // Header text (font, margin)
  content: string;        // Content area (flex-1)
}
```
