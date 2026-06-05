# Field

Form field wrapper with label, hint text, error state, required indicator, and horizontal/vertical layout. Use to wrap any form input.

## Import

```tsx
import { Field } from 'reablocks';
```

## Field Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `label` | `ReactNode \| string` | — | Field label |
| `required` | `boolean` | — | Show `*` after label |
| `direction` | `'vertical' \| 'horizontal'` | `'vertical'` | Layout direction |
| `alignment` | `'start' \| 'center' \| 'end'` | `'start'` | Label alignment |
| `hint` | `ReactNode` | — | Hint text below input (hidden when error shown) |
| `error` | `boolean \| ReactNode` | — | Error state (`true` for styling only, string/node for message) |
| `disableMargin` | `boolean` | — | Remove bottom margin |
| `className` | `string` | — | Container CSS classes |
| `labelClassName` | `string` | — | Label CSS classes |
| `onTitleClick` | `(event: MouseEvent) => void` | — | Label click handler |
| `theme` | `FieldTheme` | — | Per-instance theme override |

Also accepts all standard `<section>` HTML attributes.

## Basic Usage

```tsx
<Field label="Username">
  <Input placeholder="Enter username" />
</Field>
```

## With Hint

```tsx
<Field label="Email" hint="We'll never share your email">
  <Input type="email" />
</Field>
```

## With Error

```tsx
<Field label="Password" error="Password must be at least 8 characters">
  <Input type="password" error />
</Field>
```

## Required

```tsx
<Field label="Name" required>
  <Input />
</Field>
```

## Horizontal Layout

```tsx
<Field label="Status" direction="horizontal">
  <Toggle checked={active} onChange={setActive} />
</Field>
```

## FieldTheme Interface

```typescript
interface FieldTheme {
  base: string;          // Container (mb-2.5)
  disableMargin: string;
  label: string;         // Label (text-sm)
  centerAlign: string;
  endAlign: string;
  horizontal: {
    base: string;        // Flex row, items-baseline
    label: string;       // Right margin, nowrap
    content: string;     // flex-1, min-w-0
  };
  vertical: {
    base: string;        // Block
    label: string;       // Block, mb-0.5
  };
  hint: string;          // Hint text (text-xs, text-secondary, mt-1)
  error: string;         // Error text (text-xs, text-error, mt-1)
  errorState: string;    // Error state on container
}
```
