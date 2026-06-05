# CommandPalette

Searchable command menu with keyboard navigation, sections, hotkey support, and animated items. Typically used inside a Dialog for modal access.

## Import

```tsx
import {
  CommandPalette,
  CommandPaletteItem,
  CommandPaletteSection,
  CommandPaletteInput
} from 'reablocks';
```

## CommandPalette Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `search` | `string` | — | Controlled search input value |
| `placeholder` | `string` | — | Search input placeholder text |
| `selected` | `number` | — | Controlled selected item index |
| `autoFocus` | `boolean` | `true` | Auto-focus the search input |
| `emptyMessage` | `string` | — | Message when no items match |
| `inputIcon` | `ReactNode` | `SearchIcon` | Icon in the search input |
| `onSearchChange` | `(value: string) => void` | — | Search value change callback |
| `onSelectedIndexChange` | `(value: number) => void` | — | Selection index change callback |
| `onHotkey` | `(hotkey: HotkeyItem) => void` | — | Hotkey trigger callback |
| `theme` | `CommandPaletteTheme` | — | Per-instance theme override |
| `children` | `ReactNode` | — | Sections and items |

## CommandPaletteSection Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `title` | `string` | — | Section header title |
| `className` | `string` | — | Additional CSS classes |
| `children` | `ReactNode` | — | Section items |

## CommandPaletteItem Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `hotkey` | `string` | — | Hotkey shortcut (displayed with Kbd) |
| `children` | `ReactNode` | — | Item content |
| `active` | `boolean` | — | Active state |
| `end` | `ReactNode` | — | End adornment |
| `onClick` | `() => void` | — | Click handler |
| `className` | `string` | — | Additional CSS classes |

## Basic Usage

```tsx
<CommandPalette>
  <CommandPaletteSection title="Actions">
    <CommandPaletteItem onClick={() => doSomething()}>
      New File
    </CommandPaletteItem>
    <CommandPaletteItem onClick={() => doSomethingElse()}>
      Open Settings
    </CommandPaletteItem>
  </CommandPaletteSection>
  <CommandPaletteSection title="Navigation">
    <CommandPaletteItem onClick={() => navigate('/home')}>
      Go to Home
    </CommandPaletteItem>
  </CommandPaletteSection>
</CommandPalette>
```

## With Icons

```tsx
<CommandPaletteSection title="Actions">
  <CommandPaletteItem
    start={<FileIcon />}
    onClick={() => newFile()}
  >
    New File
  </CommandPaletteItem>
  <CommandPaletteItem
    start={<SettingsIcon />}
    onClick={() => openSettings()}
  >
    Settings
  </CommandPaletteItem>
</CommandPaletteSection>
```

## With Hotkeys

```tsx
<CommandPaletteItem hotkey="mod+n" onClick={() => newFile()}>
  New File
</CommandPaletteItem>
<CommandPaletteItem hotkey="mod+," onClick={() => openSettings()}>
  Settings
</CommandPaletteItem>
```

When `onHotkey` is provided on the CommandPalette, pressing the hotkey triggers the callback with the matched item.

## Inside a Dialog

Common pattern — open with a keyboard shortcut:

```tsx
const [open, setOpen] = useState(false);

<Dialog open={open} onClose={() => setOpen(false)}>
  <CommandPalette
    placeholder="Type a command..."
    onSearchChange={setSearch}
  >
    <CommandPaletteSection title="Commands">
      <CommandPaletteItem onClick={() => { action(); setOpen(false); }}>
        Do Something
      </CommandPaletteItem>
    </CommandPaletteSection>
  </CommandPalette>
</Dialog>
```

## Empty State

```tsx
<CommandPalette emptyMessage="No results found">
  {filteredItems.length === 0 ? null : (
    <CommandPaletteSection title="Results">
      {filteredItems.map(item => (
        <CommandPaletteItem key={item.id}>{item.label}</CommandPaletteItem>
      ))}
    </CommandPaletteSection>
  )}
</CommandPalette>
```

## Keyboard Navigation

- **Arrow Up/Down** — navigate between items
- **Enter** — select the active item
- **Hotkey shortcuts** — trigger items with assigned hotkeys

## CommandPaletteTheme Interface

```typescript
interface CommandPaletteTheme {
  base: string;              // Root container
  inner: string;             // Items container
  emptyContainer: string;    // Empty state container
  input: {
    base: string;            // Input container
    input: string;           // Input element
    icon: string;            // Search icon wrapper
  };
  item: {
    base: string;            // Item container
    active: string;          // Active item highlight
    clickable: string;       // Clickable item styles
  };
  section: {
    base: string;            // Section container
    first: string;           // First section override
  };
}
```
