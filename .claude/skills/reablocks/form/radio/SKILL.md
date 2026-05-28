# Radio

Radio button with animated indicator and label. Use standalone or inside RadioGroup for managed selection.

## Import

```tsx
import { Radio, RadioGroup } from 'reablocks';
```

## Radio Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `checked` | `boolean` | — | Whether checked (standalone use; managed by RadioGroup) |
| `value` | `any` | — | Value passed to RadioGroup on selection |
| `label` | `string \| ReactNode` | — | Label text or element |
| `disabled` | `boolean` | — | Disable the radio |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Radio size |
| `onChange` | `(value: boolean) => void` | — | Change handler |
| `onBlur` | `(event: FocusEvent) => void` | — | Blur handler |
| `className` | `string` | — | Additional CSS classes |
| `theme` | `RadioTheme` | — | Per-instance theme override |

Renders with `role="radio"`, `aria-checked`, keyboard support (Space).

## Standalone Usage

```tsx
const [checked, setChecked] = useState(false);
<Radio checked={checked} label="Option A" onChange={setChecked} />
```

## RadioGroup

Manages selection across multiple Radio buttons via React Context.

### RadioGroup Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `selectedValue` | `any` | — | Currently selected value |
| `onChange` | `(value: any) => void` | — | Selection change handler |
| `className` | `string` | — | Container CSS classes |
| `children` | `ReactNode` | — | Radio elements |

### RadioGroup Usage

```tsx
const [value, setValue] = useState('option1');

<RadioGroup selectedValue={value} onChange={setValue}>
  <Radio value="option1" label="Option 1" />
  <Radio value="option2" label="Option 2" />
  <Radio value="option3" label="Option 3" />
</RadioGroup>
```

When inside a RadioGroup, each Radio's `checked` state is determined by comparing its `value` to the group's `selectedValue`.

## RadioTheme Interface

```typescript
interface RadioTheme {
  base: string;
  radio: { base: string; disabled: string; checked: string };
  indicator: {
    base: string;
    disabled: string;
    sizes: { small, medium, large };
  };
  label: { base: string; clickable: string; checked: string; disabled: string };
  sizes: { small, medium, large };
}
```
