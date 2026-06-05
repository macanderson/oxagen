# Button

A versatile action trigger component built on Framer Motion with support for variants, colors, sizes, icons, and full theme customization.

## Import

```tsx
import { Button, ButtonGroup } from 'reablocks';
```

## Button Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `color` | `'default' \| 'primary' \| 'secondary' \| 'destructive' \| string` | `'default'` | Color variation |
| `variant` | `'filled' \| 'outline' \| 'text' \| 'ghost' \| string` | `'filled'` | Style variant |
| `size` | `'small' \| 'medium' \| 'large' \| string` | `'medium'` | Size variation |
| `fullWidth` | `boolean` | `false` | Take full width of container |
| `disabled` | `boolean` | `false` | Disable the button |
| `animated` | `boolean` | `true` | Enable press animation (scale to 0.9) |
| `start` | `ReactNode` | — | Element before button content (e.g. icon) |
| `end` | `ReactNode` | — | Element after button content (e.g. icon) |
| `disableMargins` | `boolean` | `false` | Remove margins |
| `disablePadding` | `boolean` | `false` | Remove padding |
| `theme` | `ButtonTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes (merged last, highest priority) |
| `type` | `string` | `'button'` | HTML button type attribute |

Also accepts all standard `HTMLButtonElement` attributes.

## Basic Usage

```tsx
<Button color="primary">Click Me</Button>
```

## Variants

Four built-in style variants:

```tsx
<Button variant="filled" color="primary">Filled</Button>
<Button variant="outline" color="primary">Outline</Button>
<Button variant="text" color="primary">Text</Button>
<Button variant="ghost" color="primary">Ghost</Button>
```

- **filled** — solid background with hover state
- **outline** — border only, no background fill
- **text** — text only, no border or background
- **ghost** — transparent, minimal styling

## Colors

Four built-in color schemes, each applied per-variant:

```tsx
<Button color="default" variant="filled">Default</Button>
<Button color="primary" variant="filled">Primary</Button>
<Button color="secondary" variant="filled">Secondary</Button>
<Button color="destructive" variant="filled">Destructive</Button>
```

Colors work with all variants. For example, `color="primary"` + `variant="outline"` renders a primary-colored outlined button.

## Sizes

Three built-in sizes:

```tsx
<Button color="primary" size="small">Small</Button>
<Button color="primary" size="medium">Medium</Button>
<Button color="primary" size="large">Large</Button>
```

## With Icons

Use `start` and `end` props to add icons. Icon SVGs are automatically sized based on button size:

```tsx
<Button size="medium" start={<SearchIcon />}>
  Search
</Button>

<Button size="medium" end={<ArrowRightIcon />}>
  Next
</Button>

<Button size="large" start={<PlusIcon />} end={<ChevronIcon />}>
  Add Item
</Button>
```

Adornment icon sizing per size: small = `w-3 h-3`, medium = `w-4 h-4`, large = `w-5 h-5`.

## Full Width

```tsx
<Button color="primary" fullWidth>
  Full Width Button
</Button>
```

## Disabled

Disabled buttons get reduced opacity and `cursor-not-allowed`. Animation is automatically disabled:

```tsx
<Button disabled color="primary" variant="filled">Disabled Filled</Button>
<Button disabled color="primary" variant="outline">Disabled Outline</Button>
```

## Theme Customization

### Custom Color

Add a new color by extending the theme:

```tsx
import { ThemeProvider, theme, extendTheme, PartialReablocksTheme } from 'reablocks';

const customTheme: PartialReablocksTheme = {
  components: {
    button: {
      colors: {
        gradient: {
          filled: 'bg-linear-to-r from-blue-500 to-purple-500 text-white'
        }
      }
    }
  }
};

<ThemeProvider theme={extendTheme(theme, customTheme)}>
  <Button color="gradient">Gradient</Button>
</ThemeProvider>
```

### Custom Variant

Add a new variant:

```tsx
const customTheme: PartialReablocksTheme = {
  components: {
    button: {
      variants: {
        gradient: 'border rounded-lg'
      },
      colors: {
        primary: {
          gradient: 'bg-linear-to-r from-blue-500 to-purple-500 border-blue-500'
        },
        secondary: {
          gradient: 'bg-linear-to-r from-pink-500 to-purple-500 border-pink-500'
        }
      }
    }
  }
};

<ThemeProvider theme={extendTheme(theme, customTheme)}>
  <Button variant="gradient" color="primary">Gradient Primary</Button>
  <Button variant="gradient" color="secondary">Gradient Secondary</Button>
</ThemeProvider>
```

### Custom Size

Add custom sizes:

```tsx
const customTheme: PartialReablocksTheme = {
  components: {
    button: {
      sizes: {
        xsmall: 'text-xxs px-1 py-0.5',
        xlarge: 'text-xl px-6 py-3'
      }
    }
  }
};

<ThemeProvider theme={extendTheme(theme, customTheme)}>
  <Button size="xsmall">Extra Small</Button>
  <Button size="xlarge">Extra Large</Button>
</ThemeProvider>
```

### Merging Classes

To append Tailwind classes to existing theme values instead of replacing them, use `mergeThemeClasses`:

```tsx
import { extendTheme, mergeThemeClasses, theme } from 'reablocks';

const customTheme: PartialReablocksTheme = {
  components: {
    button: {
      base: 'transition-colors'  // appended to existing base classes
    }
  }
};

<ThemeProvider theme={extendTheme(theme, customTheme, mergeThemeClasses)}>
  ...
</ThemeProvider>
```

## ButtonTheme Interface

The complete theme structure for Button:

```typescript
interface ButtonTheme {
  base: string;           // Base classes for all buttons
  disabled: string;       // Disabled state classes
  fullWidth: string;      // Full-width classes
  group: string;          // Classes when inside ButtonGroup
  groupText: string;      // Classes when inside ButtonGroup with text variant
  variants: {             // Per-variant base classes
    filled: string;
    outline: string;
    text: string;
    ghost: string;
    [key: string]: string;  // extensible
  };
  colors: {               // Per-color, per-variant classes
    primary: { filled, outline, text, ghost };
    secondary: { filled, outline, text, ghost };
    destructive: { filled, outline, text, ghost };
    [key: string]: { [variant: string]: string };  // extensible
  };
  sizes: {                // Per-size classes
    small: string;
    medium: string;
    large: string;
    [key: string]: string;  // extensible
  };
  iconSizes: {            // Icon-only button sizes
    small: string;
    medium: string;
    large: string;
  };
  adornment: {            // Icon adornment configuration
    base: string;
    start: { small, medium, large };  // start icon spacing per size
    end: { small, medium, large };    // end icon spacing per size
    sizes: { small, medium, large };  // icon dimensions per size
  };
}
```

---

# ButtonGroup

Groups multiple buttons together with shared variant and size. Buttons inside a group have their border-radius adjusted (first gets left radius, last gets right radius).

## ButtonGroup Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'filled' \| 'outline' \| 'text' \| 'ghost'` | `'filled'` | Shared variant for all child buttons |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Shared size for all child buttons |
| `children` | `ReactNode` | — | Button elements to group |
| `className` | `string` | — | Additional CSS classes for the group wrapper |

## ButtonGroup Usage

```tsx
<ButtonGroup variant="filled">
  <Button>One</Button>
  <Button>Two</Button>
  <Button>Three</Button>
</ButtonGroup>
```

### Variants in Groups

```tsx
<ButtonGroup variant="outline">
  <Button>A</Button>
  <Button>B</Button>
  <Button>C</Button>
</ButtonGroup>

<ButtonGroup variant="text">
  <Button>A</Button>
  <Button>B</Button>
  <Button>C</Button>
</ButtonGroup>
```

### Group Sizes

```tsx
<ButtonGroup size="small">
  <Button>S1</Button>
  <Button>S2</Button>
</ButtonGroup>

<ButtonGroup size="large">
  <Button>L1</Button>
  <Button>L2</Button>
</ButtonGroup>
```

**Note:** When a Button is inside a ButtonGroup, the group's `variant` and `size` override the individual button's props. The ButtonGroup uses React Context (`ButtonGroupContext`) to propagate these values.
