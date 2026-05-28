# Textarea

Auto-resizing multi-line text input built on `react-textarea-autosize`. Supports sizes, error state, and imperative ref API.

## Import

```tsx
import { Textarea } from 'reablocks';
```

## Textarea Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Textarea size |
| `fullWidth` | `boolean` | — | Take full container width |
| `error` | `boolean` | — | Error state (red border) |
| `containerClassName` | `string` | — | CSS classes for the container div |
| `className` | `string` | — | CSS classes for the textarea element |
| `theme` | `TextareaTheme` | — | Per-instance theme override |

Also accepts all `TextareaAutosizeProps` from `react-textarea-autosize` (e.g. `minRows`, `maxRows`, `placeholder`, `disabled`, `value`, `onChange`).

## Basic Usage

```tsx
<Textarea placeholder="Enter description..." />
```

## Sizes

```tsx
<Textarea size="small" placeholder="Small" />
<Textarea size="medium" placeholder="Medium" />
<Textarea size="large" placeholder="Large" />
```

## Full Width with Error

```tsx
<Textarea fullWidth error placeholder="Required field" />
```

## Ref API

```tsx
const ref = useRef<TextAreaRef>(null);

<Textarea ref={ref} />

// Imperative methods:
ref.current.focus();
ref.current.blur();
ref.current.textareaRef;    // HTMLTextAreaElement ref
ref.current.containerRef;   // Container div ref
```

## TextareaTheme Interface

```typescript
interface TextareaTheme {
  base: string;       // Container (flex, border, rounded, bg, transition)
  input: string;      // Textarea element (resize-none, bg-transparent)
  fullWidth: string;  // Full width override
  error: string;      // Error border
  disabled: string;   // Disabled state
  sizes: { small, medium, large };
}
```
