# Select

Feature-rich dropdown select with search filtering, keyboard navigation, multi-select, creatable options, and paste support. Uses Fuse.js for fuzzy search. Renders via ConnectedOverlay (Floating UI).

## Import

```tsx
import { Select, SelectOption } from 'reablocks';
```

## Select Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `string \| string[]` | — | Selected value(s) |
| `onChange` | `(value) => void` | — | Value change handler |
| `children` | `SelectOption elements` | — | Option elements |
| `multiple` | `boolean` | — | Enable multi-select |
| `filterable` | `boolean \| 'async'` | `true` | Enable search filtering (`'async'` for external filtering) |
| `clearable` | `boolean` | `true` | Show clear button |
| `createable` | `boolean` | — | Allow creating new options by typing |
| `disabled` | `boolean` | — | Disable the select |
| `error` | `boolean` | — | Error state |
| `loading` | `boolean` | — | Loading indicator |
| `placeholder` | `string` | — | Placeholder text |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Select size |
| `closeOnSelect` | `boolean` | `true` | Close menu after selection |
| `menuPlacement` | `Placement` | `'bottom-start'` | Menu positioning |
| `menuDisabled` | `boolean` | `false` | Disable dropdown menu |
| `refreshable` | `boolean` | `false` | Show refresh button for async options |
| `tabToSelect` | `boolean` | — | Use Tab key to select active option |
| `selectOnPaste` | `boolean` | — | Select options on paste |
| `selectOnKeys` | `string[]` | `['Enter']` | Keys that trigger selection |
| `clearOnBlur` | `boolean` | `true` | Clear search text on blur |
| `start` | `ReactNode` | — | Content before the input |
| `end` | `ReactNode` | — | Content after input (before action buttons) |
| `required` | `boolean` | — | Required field |
| `defaultFilterValue` | `string` | — | Default search filter text |
| `searchOptions` | `Fuse.IFuseOptions` | — | Custom Fuse.js search options |
| `input` | `ReactElement` | `<SelectInput />` | Custom input component |
| `menu` | `ReactElement` | `<SelectMenu />` | Custom menu component |
| `className` | `string` | — | Input CSS classes |
| `containerClassName` | `string` | — | Container CSS classes |
| `activeClassName` | `string` | — | CSS classes when menu is open |
| `theme` | via SelectInput/SelectMenu | — | Theme overrides |

## SelectOption

```tsx
<SelectOption value="option1">Option 1</SelectOption>
<SelectOption value="option2" disabled>Option 2</SelectOption>
<SelectOption value="option3" group="Group A">Option 3</SelectOption>
```

## Single Select

```tsx
const [value, setValue] = useState<string>();

<Select value={value} onChange={setValue} placeholder="Select...">
  <SelectOption value="apple">Apple</SelectOption>
  <SelectOption value="banana">Banana</SelectOption>
  <SelectOption value="cherry">Cherry</SelectOption>
</Select>
```

## Multi Select

```tsx
const [values, setValues] = useState<string[]>([]);

<Select multiple value={values} onChange={setValues} placeholder="Select items...">
  <SelectOption value="a">Item A</SelectOption>
  <SelectOption value="b">Item B</SelectOption>
  <SelectOption value="c">Item C</SelectOption>
</Select>
```

## Creatable

```tsx
<Select createable value={value} onChange={setValue} placeholder="Type to create...">
  <SelectOption value="existing">Existing Option</SelectOption>
</Select>
```

## Grouped Options

```tsx
<Select value={value} onChange={setValue}>
  <SelectOption value="a" group="Fruits">Apple</SelectOption>
  <SelectOption value="b" group="Fruits">Banana</SelectOption>
  <SelectOption value="c" group="Vegetables">Carrot</SelectOption>
</Select>
```

## Keyboard Navigation

- **Arrow Up/Down** — navigate options
- **Enter** — select active option
- **Escape** — close menu
- **Tab** — close menu (or select if `tabToSelect`)
