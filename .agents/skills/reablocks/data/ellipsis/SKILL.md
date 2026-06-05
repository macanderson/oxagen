# Ellipsis

Truncates text with expandable "..." toggle. Supports character limit and line-based truncation with responsive re-measurement.

## Import

```tsx
import { Ellipsis } from 'reablocks';
```

## Ellipsis Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `string` | — | Text to truncate |
| `limit` | `number` | `256` | Character limit for truncation |
| `lines` | `number` | — | Number of lines to show (overrides character limit) |
| `expandable` | `boolean` | `true` | Allow expanding truncated text |
| `moreText` | `string` | `'...'` | Text for the expand button |
| `lessText` | `string` | `'Show less'` | Text for the collapse button |
| `removeLinebreaks` | `boolean` | `true` | Replace line breaks with spaces |
| `title` | `string \| false` | — | Hover title (defaults to full value, `false` to disable) |
| `className` | `string` | — | Additional CSS classes |
| `theme` | `EllipsisTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<Ellipsis value="A very long text string that exceeds the character limit..." />
```

## Non-Expandable

```tsx
<Ellipsis expandable={false} value={longText} />
{/* Shows truncated text with "..." but no expand button */}
```

## Line-Based Truncation

When `lines` is set, truncation is based on visible lines rather than character count. Responsive — re-measures on window resize.

```tsx
<div style={{ width: 250 }}>
  <Ellipsis lines={3} value={longText} />
</div>
```

## EllipsisTheme Interface

```typescript
interface EllipsisTheme {
  dots: string;  // Expand/collapse button styles (cursor-pointer, opacity)
}
```
