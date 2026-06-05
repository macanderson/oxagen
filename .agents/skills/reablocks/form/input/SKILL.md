# Input

Text input with start/end adornments, error state, sizes, and imperative ref API. Also includes DebouncedInput and InlineInput variants.

## Import

```tsx
import { Input, DebouncedInput, InlineInput } from 'reablocks';
```

## Input Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Input size |
| `fullWidth` | `boolean` | — | Take full container width |
| `error` | `boolean` | — | Error state (red border) |
| `disabled` | `boolean` | — | Disable the input |
| `selectOnFocus` | `boolean` | — | Select all text on focus |
| `start` | `ReactNode \| string` | — | Content before the input (e.g. icon) |
| `end` | `ReactNode \| string` | — | Content after the input (e.g. icon) |
| `onValueChange` | `(value: string) => void` | — | Shortcut for onChange value extraction |
| `containerClassname` | `string` | — | CSS classes for the container div |
| `className` | `string` | — | CSS classes for the input element |
| `theme` | `InputTheme` | — | Per-instance theme override |

Also accepts all standard `<input>` HTML attributes (except `size`).

## Basic Usage

```tsx
<Input placeholder="Enter text..." onValueChange={setValue} />
```

## With Adornments

```tsx
<Input start={<SearchIcon />} placeholder="Search..." />
<Input end={<ClearIcon />} placeholder="Type here..." />
```

## Sizes

```tsx
<Input size="small" placeholder="Small" />
<Input size="medium" placeholder="Medium" />
<Input size="large" placeholder="Large" />
```

## Error State

```tsx
<Input error placeholder="Invalid input" />
```

## Ref API

```tsx
const ref = useRef<InputRef>(null);

<Input ref={ref} />

// Imperative methods:
ref.current.focus();
ref.current.blur();
ref.current.select();
ref.current.inputRef;      // HTMLInputElement ref
ref.current.containerRef;  // Container div ref
```

---

# DebouncedInput

Wraps Input with debounced onChange. Enter key bypasses debounce.

## DebouncedInput Props

Extends all Input props, plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `debounce` | `number` | `100` | Debounce delay in milliseconds |

```tsx
<DebouncedInput
  debounce={300}
  placeholder="Search..."
  onValueChange={handleSearch}
/>
```

---

# InlineInput

Auto-sizing inline input that grows with its content. Uses CSS grid for width calculation.

## InlineInput Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `className` | `string` | — | Container CSS classes |
| `inputClassName` | `string` | — | Input element CSS classes |
| `extraWidth` | `number \| string` | — | Additional width for the input |
| `theme` | `InputTheme` | — | Per-instance theme override |

Also accepts all standard `<input>` HTML attributes.

```tsx
<InlineInput placeholder="Type..." value={value} onChange={handleChange} />
```

## InputTheme Interface

```typescript
interface InputTheme {
  base: string;       // Container (flex, border, rounded, bg, transition)
  input: string;      // Input element (flex-1, bg-transparent, outline-hidden)
  inline: string;     // InlineInput specific styles
  focused: string;    // Focused container state
  disabled: string;   // Disabled state
  fullWidth: string;  // Full width override
  error: string;      // Error border
  sizes: { small, medium, large };
  adornment: {
    base: string;     // Adornment container (flex, items-center, svg sizing)
    start: string;    // Start adornment spacing
    end: string;      // End adornment spacing
  };
}
```
