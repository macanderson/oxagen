---
name: reablocks
description: Use when building UI in React with the reablocks component library (Button, Dialog, Drawer, Select, Calendar, CommandPalette, Tabs, Tree, Tooltip, etc.). Covers ThemeProvider setup, extendTheme, custom variants, mergeThemeClasses, useComponentTheme/useTheme hooks, and the 50+ component index.
---

# Reablocks

Reablocks is a React UI component library with 50+ components built on **Tailwind CSS** and **Framer Motion**. It provides a comprehensive theming system, accessible components, and consistent design patterns.

## Installation

```bash
npm install reablocks
```

## ThemeProvider Setup

Every app using reablocks must be wrapped in a `ThemeProvider`:

```tsx
import { ThemeProvider, theme } from 'reablocks';

function App() {
  return (
    <ThemeProvider theme={theme}>
      <YourApp />
    </ThemeProvider>
  );
}
```

### ThemeProvider Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `theme` | `ReablocksTheme` | Yes | The theme to apply |

### Built-in Themes

- **`theme`** — standard theme using Tailwind utility classes
- **`themeUnify`** — design system theme using CSS custom properties (requires `import 'reablocks/unify.css'`)

```tsx
// Default theme
import { ThemeProvider, theme } from 'reablocks';
<ThemeProvider theme={theme}>...</ThemeProvider>

// Unify theme
import { ThemeProvider, themeUnify } from 'reablocks';
import 'reablocks/unify.css';
<ThemeProvider theme={themeUnify}>...</ThemeProvider>
```

## Theme Customization

### extendTheme

Use `extendTheme()` to deep-merge partial overrides into a base theme. Only specify the properties you want to change:

```tsx
import { ThemeProvider, theme, extendTheme, PartialReablocksTheme } from 'reablocks';

const customTheme: PartialReablocksTheme = {
  components: {
    button: {
      colors: {
        primary: {
          filled: 'bg-blue-500 hover:bg-blue-600 text-white'
        }
      }
    }
  }
};

<ThemeProvider theme={extendTheme(theme, customTheme)}>
  <App />
</ThemeProvider>
```

### Adding a Custom Variant

You can extend any component with new variants and colors. Only provide the keys you want to add — existing values remain intact:

```tsx
import { ThemeProvider, theme, extendTheme, PartialReablocksTheme } from 'reablocks';

const customTheme: PartialReablocksTheme = {
  components: {
    button: {
      // Add a new variant with its base styles
      variants: {
        gradient: 'border rounded-lg'
      },
      // Add color mappings for the new variant
      colors: {
        primary: {
          gradient: 'bg-linear-to-r from-blue-500 to-purple-500 border-blue-500 text-white'
        },
        secondary: {
          gradient: 'bg-linear-to-r from-pink-500 to-purple-500 border-pink-500 text-white'
        }
      }
    }
  }
};

<ThemeProvider theme={extendTheme(theme, customTheme)}>
  {/* Use the new variant just like built-in ones */}
  <Button variant="gradient" color="primary">Gradient Primary</Button>
  <Button variant="gradient" color="secondary">Gradient Secondary</Button>
</ThemeProvider>
```

The same pattern works for adding custom colors, sizes, or entirely new theme keys to any component.

### mergeThemeClasses

By default, `extendTheme` **replaces** theme string values. To **merge** Tailwind classes (append instead of replace), pass `mergeThemeClasses` as the third argument:

```tsx
import { extendTheme, mergeThemeClasses, theme } from 'reablocks';

const merged = extendTheme(theme, customTheme, mergeThemeClasses);
```

### extendComponentTheme

Extend a single component's theme:

```tsx
import { extendComponentTheme, defaultButtonTheme } from 'reablocks';

const myButtonTheme = extendComponentTheme(defaultButtonTheme, {
  sizes: { xlarge: 'text-xl px-6 py-3' }
});
```

## Theme Hooks

### useComponentTheme

Get a specific component's theme from context. Pass an optional custom theme to override:

```tsx
import { useComponentTheme } from 'reablocks';

function MyComponent({ theme: customTheme }) {
  const theme = useComponentTheme('button', customTheme);
  return <button className={theme.base}>...</button>;
}
```

### useTheme

Access the full theme context including CSS tokens and runtime updates:

```tsx
import { useTheme } from 'reablocks';

function MyComponent() {
  const { theme, tokens, updateTheme, updateTokens } = useTheme();
  // tokens = Record<string, string> of CSS custom properties
  // updateTheme() for runtime theme switching
}
```

## Common Component Patterns

When working with reablocks components, follow these conventions:

- **Import from barrel**: Always `import { Component } from 'reablocks'`
- **forwardRef**: All components use `forwardRef` and accept a `ref` prop
- **className**: Components accept `className` which is merged last (highest priority) via `cn()` (tailwind-merge)
- **theme prop**: Components accept a `theme` prop for per-instance theme override
- **cn() utility**: Use `cn()` for Tailwind class merging — combines `classnames` + `tailwind-merge` to deduplicate/resolve conflicts
- **Animations**: Framer Motion powers animations; use `animated` prop (boolean) to toggle
- **Controlled/Uncontrolled**: Form components support both patterns

## ReablocksTheme Component Keys

The `theme.components` object contains theme configs for every component:

```
avatar, avatarGroup, badge, button, chip, checkbox, contextMenu,
dateFormat, dialog, divider, dotsLoader, drawer, ellipsis, field,
select, list, menu, sort, card, kbd, notification, input, dateInput,
calendar, calendarRange, commandPalette, collapse, textarea, radio,
range, redact, toggle, tooltip, tree, jsonTree, popover, pager,
tabs, breadcrumbs, stepper, callout, backdrop, navigation, skeleton,
typography
```

## Component Index

### Elements
Avatar, AvatarGroup, Badge, **Button**, Chip, CommandPalette, IconButton, Kbd, Loader, Navigation, Skeleton

### Form
Calendar, Checkbox, DateInput, Input (DebouncedInput, InlineInput), Radio, Range, Select (SingleSelect, MultiSelect), Textarea, Toggle

### Layout
Breadcrumbs, Card, Collapse, Divider, Field, List, Motion, Stepper, Tabs, Tree

### Layers
Backdrop, Callout, ConfirmDialog, ContextMenu, Dialog, Drawer, Menu, Notification, Popover, Tooltip

### Typography
H1, H2, H3, H4, H5, H6, P, BlockQuote, Lead, Large, Small, Muted

### Data
DataSize, DateFormat, Duration, Ellipsis, InfinityList, Pager, Pluralize, Redact, Sort
