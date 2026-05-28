# ConfirmDialog

Confirmation dialog with accept/reject actions. Built on Dialog. Also exports `useConfirmDialog` hook for imperative usage.

## Import

```tsx
import { ConfirmDialog, useConfirmDialog } from 'reablocks';
```

## ConfirmDialog Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `open` | `boolean` | — | Whether the dialog is open |
| `header` | `string \| ReactNode` | — | Dialog header |
| `content` | `string \| ReactNode` | — | Dialog body content |
| `confirmLabel` | `string` | `'Confirm'` | Confirm button text |
| `cancelLabel` | `string` | `'Cancel'` | Cancel button text |
| `onConfirm` | `() => void` | — | Confirm callback |
| `onCancel` | `() => void` | — | Cancel callback (also closes the dialog) |

## Basic Usage

```tsx
const [open, setOpen] = useState(false);

<ConfirmDialog
  open={open}
  header="Delete Item"
  content="Are you sure you want to delete this item?"
  onConfirm={() => { deleteItem(); setOpen(false); }}
  onCancel={() => setOpen(false)}
/>
```

## useConfirmDialog Hook

Imperative API for opening confirm dialogs without managing state:

```tsx
const { openDialog, closeDialog, DialogComponent } = useConfirmDialog();

<Button onClick={() => openDialog({
  header: 'Confirm Action',
  content: 'Are you sure?',
  onConfirm: () => { doAction(); closeDialog(); },
  onCancel: () => closeDialog()
})}>
  Delete
</Button>

<DialogComponent />
```

### Hook Returns

| Property | Type | Description |
|----------|------|-------------|
| `isOpen` | `boolean` | Current open state |
| `openDialog` | `(props: OpenConfirmDialogProps) => void` | Open with props |
| `closeDialog` | `() => void` | Close the dialog |
| `DialogComponent` | `FC` | Render this in your JSX |
