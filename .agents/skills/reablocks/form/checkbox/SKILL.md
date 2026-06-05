# Checkbox

Animated checkbox with SVG check/intermediate marks, label support, and keyboard accessibility. Built on Framer Motion with customizable SVG paths.

## Import

```tsx
import { Checkbox } from 'reablocks';
```

## Checkbox Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `checked` | `boolean` | `false` | Whether the checkbox is checked |
| `intermediate` | `boolean` | `false` | Intermediate/indeterminate state |
| `label` | `string \| ReactNode` | — | Label text or element |
| `labelPosition` | `'start' \| 'end'` | `'end'` | Label placement relative to checkbox |
| `disabled` | `boolean` | — | Disable the checkbox |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Checkbox size |
| `onChange` | `(value: boolean) => void` | — | Change handler (receives new checked state) |
| `onBlur` | `(event: FocusEvent) => void` | — | Blur handler |
| `className` | `string` | — | CSS classes for the checkbox element |
| `containerClassName` | `string` | — | CSS classes for the outer container |
| `labelClassName` | `string` | — | CSS classes for the label |
| `borderPath` | `string` | rounded rect | Custom SVG path for the box border |
| `checkedPath` | `string` | checkmark | Custom SVG path for checked state |
| `intermediatePath` | `string` | dash | Custom SVG path for intermediate state |
| `theme` | `CheckboxTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
const [checked, setChecked] = useState(false);
<Checkbox checked={checked} label="Accept terms" onChange={setChecked} />
```

## Intermediate State

```tsx
<Checkbox checked={checked} intermediate label="Select all" onChange={setChecked} />
```

## Label Position

```tsx
<Checkbox checked={checked} label="Start label" labelPosition="start" onChange={setChecked} />
<Checkbox checked={checked} label="End label" labelPosition="end" onChange={setChecked} />
```

## Sizes

```tsx
<Checkbox checked={checked} size="small" label="Small" onChange={setChecked} />
<Checkbox checked={checked} size="medium" label="Medium" onChange={setChecked} />
<Checkbox checked={checked} size="large" label="Large" onChange={setChecked} />
```

## Custom SVG Paths

```tsx
<Checkbox
  borderPath="M2 0.5h12s1.5 0 1.5 1.5v12s0 1.5 ..."
  checkedPath="M14.49 2.99..."
  checked={checked}
  label="Custom check"
  onChange={setChecked}
/>
```

## Custom Label

```tsx
<Checkbox
  checked={checked}
  label={<div><span className="mr-1">Check</span><b>me</b></div>}
  onChange={setChecked}
/>
```

## CheckboxTheme Interface

```typescript
interface CheckboxTheme {
  base: string;
  label: {
    base: string;
    clickable: string;
    disabled: string;
    checked: string;
    sizes: { small, medium, large };
  };
  border: { base: string; disabled: string; checked: string };
  check: { base: string; disabled: string; checked: string };
  checkbox: { base: string; disabled: string; checked: string };
  sizes: { small, medium, large };
  boxVariants: {
    hover: { strokeWidth, stroke, fill };
    pressed: { scale };
    checked: { stroke, fill };
    unchecked: { stroke, fill };
  };
}
```
