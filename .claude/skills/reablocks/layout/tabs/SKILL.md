# Tabs

Tabbed content navigation with animated selection indicator. Composed of Tabs, TabList, Tab, and TabPanel. Supports controlled and uncontrolled modes.

## Import

```tsx
import { Tabs, TabList, Tab, TabPanel } from 'reablocks';
```

## Tabs Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `selectedIndex` | `number` | — | Controlled active tab index |
| `defaultIndex` | `number` | `0` | Default active tab (uncontrolled) |
| `variant` | `'primary' \| 'secondary' \| 'outlined' \| 'text'` | `'primary'` | Tab style variant |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | Tab size |
| `direction` | `'ltr' \| 'rtl'` | `'ltr'` | Text direction |
| `onSelect` | `(index: number) => void` | — | Tab selection callback |
| `className` | `string` | — | Container CSS classes |
| `style` | `CSSProperties` | — | Inline styles |
| `theme` | `TabsTheme` | — | Per-instance theme override |

## Tab Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `disabled` | `boolean` | — | Disable the tab |
| `start` | `ReactElement` | — | Element before tab text |
| `end` | `ReactElement` | — | Element after tab text |
| `className` | `string` | — | Tab button CSS classes |
| `containerClassName` | `string` | — | Tab wrapper CSS classes |

## Basic Usage

```tsx
<Tabs>
  <TabList>
    <Tab>Tab 1</Tab>
    <Tab>Tab 2</Tab>
    <Tab>Tab 3</Tab>
  </TabList>
  <TabPanel>Content 1</TabPanel>
  <TabPanel>Content 2</TabPanel>
  <TabPanel>Content 3</TabPanel>
</Tabs>
```

## Controlled

```tsx
const [index, setIndex] = useState(0);

<Tabs selectedIndex={index} onSelect={setIndex}>
  <TabList>
    <Tab>First</Tab>
    <Tab>Second</Tab>
  </TabList>
  <TabPanel>First panel</TabPanel>
  <TabPanel>Second panel</TabPanel>
</Tabs>
```

## Variants

```tsx
<Tabs variant="primary">...</Tabs>   {/* Contained/filled style */}
<Tabs variant="secondary">...</Tabs> {/* Underline indicator */}
<Tabs variant="outlined">...</Tabs>  {/* Bordered tabs */}
<Tabs variant="text">...</Tabs>      {/* Text-only, no borders */}
```

## With Icons

```tsx
<TabList>
  <Tab start={<HomeIcon />}>Home</Tab>
  <Tab start={<SettingsIcon />}>Settings</Tab>
</TabList>
```

Active tab shows an animated underline indicator via Framer Motion `layoutId`.

## TabsTheme Interface

```typescript
interface TabsTheme {
  base: string;        // Container (flex-col)
  list: {
    base: string;      // Tab list (flex, flex-wrap)
    indicator: {
      base: string;    // Underline indicator (bg, absolute)
      size: { small, medium, large };
    };
    divider: string;   // List bottom divider
    variant: {         // Per-variant styles
      primary: { divider?, button?, selected?, disabled?, indicator? };
      secondary: { ... };
      outlined?: { ... };
      text?: { ... };
    };
    tab: {
      base: string;    // Tab container (relative)
      button: string;  // Tab button (transition, font)
      selected: string;
      disabled: string;
      size: { small, medium, large };
    };
  };
  panel: string;       // Panel container (margin-top)
}
```
