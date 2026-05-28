# Navigation

Navigation system with two components: **NavigationBar** (container) and **NavigationButton** (items). Supports vertical/horizontal layout, collapsible sidebar, animated active indicators, and start/end slots.

## Import

```tsx
import { NavigationBar, NavigationBarStart, NavigationBarEnd, NavigationButton } from 'reablocks';
```

## NavigationBar Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `direction` | `'vertical' \| 'horizontal'` | `'vertical'` | Layout direction |
| `collapsed` | `boolean` | — | Collapse the sidebar (vertical only) |
| `animation` | `NavigationBarAnimation` | — | Custom Framer Motion animation config |
| `theme` | `NavigationTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |
| `children` | `ReactNode` | — | NavigationButton elements and slots |

### Slot Components

- **`NavigationBarStart`** — Content at the top (vertical) or left (horizontal)
- **`NavigationBarEnd`** — Content at the bottom (vertical) or right (horizontal)

```tsx
<NavigationBar>
  <NavigationBarStart>
    <Logo />
  </NavigationBarStart>

  <NavigationButton active>Home</NavigationButton>
  <NavigationButton>Settings</NavigationButton>

  <NavigationBarEnd>
    <UserMenu />
  </NavigationBarEnd>
</NavigationBar>
```

## NavigationButton Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'ghost' \| 'underline'` | `'ghost'` | Button style variant |
| `active` | `boolean` | — | Active state (shows selection indicator) |
| `animated` | `boolean` | `true` | Enable animations |
| `theme` | `NavigationTheme` | — | Per-instance theme override |
| `disabled` | `boolean` | — | Disabled state |

Also accepts Framer Motion button props (`onClick`, `className`, etc.).

## Vertical Navigation (Default)

```tsx
<NavigationBar direction="vertical">
  <NavigationBarStart>
    <Logo />
  </NavigationBarStart>
  <NavigationButton active>
    <HomeIcon /> Home
  </NavigationButton>
  <NavigationButton>
    <SettingsIcon /> Settings
  </NavigationButton>
</NavigationBar>
```

## Horizontal Navigation

```tsx
<NavigationBar direction="horizontal">
  <NavigationButton variant="underline" active>Home</NavigationButton>
  <NavigationButton variant="underline">About</NavigationButton>
  <NavigationButton variant="underline">Contact</NavigationButton>
</NavigationBar>
```

## Collapsible Sidebar

```tsx
const [collapsed, setCollapsed] = useState(false);

<NavigationBar collapsed={collapsed}>
  <NavigationBarStart>
    <button onClick={() => setCollapsed(!collapsed)}>
      <MenuIcon />
    </button>
  </NavigationBarStart>
  <NavigationButton active>
    <HomeIcon />
    {!collapsed && <span>Home</span>}
  </NavigationButton>
  <NavigationButton>
    <SettingsIcon />
    {!collapsed && <span>Settings</span>}
  </NavigationButton>
</NavigationBar>
```

Default animation: spring with stiffness 300, damping 30. Collapsed width: 85px, expanded: 320px.

## Button Variants

- **ghost** — Background highlight on hover/active, rounded selection indicator
- **underline** — Bottom border indicator on active, no background

## NavigationTheme Interface

```typescript
interface NavigationTheme {
  bar: {
    base: string;              // Container (flex, padding, border, bg)
    direction: {
      horizontal: string;
      vertical: string;
    };
    start: string;             // Start slot styles
    navigation: string;        // Main nav area (flex-1, gap, overflow)
    end: string;               // End slot styles
  };
  button: {
    base: string;              // Button base (relative, shrink-0)
    variant: {
      ghost: {
        content: string;       // Button content styling
        active: string;        // Active state
        selection: string;     // Selection indicator
        disabled: string;      // Disabled state
      };
      underline: {
        content: string;
        active: string;
        selection: string;
        disabled: string;
      };
    };
  };
}
```
