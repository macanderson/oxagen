# ContextMenu

Right-click context menu using ConnectedOverlay (Floating UI). Supports focus trapping, global menu state (only one open at a time), and auto-close on click.

## Import

```tsx
import { ContextMenu } from 'reablocks';
```

## ContextMenu Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | — | Trigger element (right-click target) |
| `content` | `ReactNode \| (({ close, closeAll }) => ReactNode)` | — | Menu content |
| `disabled` | `boolean` | — | Disable the context menu |
| `autofocus` | `boolean` | `true` | Focus trap on open |
| `autoClose` | `boolean` | `true` | Close on content click |
| `closeOnEscape` | `boolean` | `true` | Close on Escape key |
| `closeOnBodyClick` | `boolean` | `true` | Close on outside click |
| `triggerClassName` | `string` | — | CSS class for the trigger wrapper |
| `triggerOpenClassName` | `string` | — | CSS class when menu is open |
| `theme` | `ContextMenuTheme` | — | Per-instance theme override |

Also accepts ConnectedOverlay props (except `open`).

## Basic Usage

```tsx
<ContextMenu content={
  <Card>
    <List>
      <ListItem onClick={() => copy()}>Copy</ListItem>
      <ListItem onClick={() => paste()}>Paste</ListItem>
      <ListItem onClick={() => del()}>Delete</ListItem>
    </List>
  </Card>
}>
  <div>Right-click me</div>
</ContextMenu>
```

## With Close Control

Content can be a render function receiving `close` and `closeAll`:

```tsx
<ContextMenu content={({ close, closeAll }) => (
  <Card>
    <List>
      <ListItem onClick={() => { action(); close(); }}>Action</ListItem>
      <ListItem onClick={closeAll}>Close All Menus</ListItem>
    </List>
  </Card>
)}>
  <div>Right-click me</div>
</ContextMenu>
```

## ContextMenuTheme Interface

```typescript
interface ContextMenuTheme {
  enabled: string;  // Cursor style when enabled (cursor-context-menu)
}
```
