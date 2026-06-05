# Notification

Toast notification system with variants, auto-dismiss, flood prevention, and custom components. Wrap your app in `<Notifications>` and use `useNotification` hook to trigger.

## Import

```tsx
import { Notifications, useNotification } from 'reablocks';
```

## Setup

Wrap your app (or a section) in the Notifications provider:

```tsx
<Notifications>
  <App />
</Notifications>
```

### Notifications Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `limit` | `number` | `10` | Maximum visible notifications |
| `timeout` | `number` | `4000` | Auto-dismiss delay in ms |
| `showClose` | `boolean` | `true` | Show close button |
| `preventFlooding` | `boolean` | `true` | Prevent duplicate messages |
| `className` | `string` | — | CSS classes for notifications |
| `components` | `{ [variant]: ComponentType }` | — | Custom notification components per variant |
| `icons` | `{ [variant]: ReactNode }` | built-in SVGs | Custom icons per variant |
| `theme` | `NotificationTheme` | — | Per-instance theme override |

## useNotification Hook

```tsx
function MyComponent() {
  const {
    notify,
    notifySuccess,
    notifyError,
    notifyWarning,
    notifyInfo,
    clearNotification,
    clearAllNotifications
  } = useNotification();

  return (
    <>
      <Button onClick={() => notify('Default message')}>Notify</Button>
      <Button onClick={() => notifySuccess('Saved!')}>Success</Button>
      <Button onClick={() => notifyError('Failed!')}>Error</Button>
      <Button onClick={() => notifyWarning('Careful!')}>Warning</Button>
      <Button onClick={() => notifyInfo('FYI...')}>Info</Button>
      <Button onClick={() => clearAllNotifications()}>Clear All</Button>
    </>
  );
}
```

## Notification Options

Both `notify()` and variant methods accept a second options argument:

```tsx
notify('Title', {
  body: 'Additional details here',          // Body text (string or ReactNode)
  variant: 'success',                       // default | success | error | warning | info
  timeout: 6000,                            // Override auto-dismiss delay
  showClose: true,                          // Show close button
  icon: <CustomIcon />,                     // Override icon
  action: <Button size="small">Undo</Button>, // Action element
  className: 'custom-class'                 // Additional CSS classes
});
```

## Custom Notification Components

```tsx
<Notifications
  components={{
    error: ({ message, onClose }) => (
      <div className="custom-error">
        {message}
        <button onClick={onClose}>Dismiss</button>
      </div>
    )
  }}
>
  <App />
</Notifications>
```

## NotificationTheme Interface

```typescript
interface NotificationTheme {
  container: string;     // Outer container
  positions: string;     // Fixed positioning (bottom-center by default)
  notification: {
    base: string;        // Notification card (flex, min-w, rounded, bg, border)
    variants: {
      default: { base: string; icon?: string };
      success: { base: string; icon?: string };
      error: { base: string; icon?: string };
      warning: { base: string; icon?: string };
      info: { base: string; icon?: string };
    };
    header: string;       // Title area
    content: string;      // Content wrapper
    body: string;         // Body text
    closeContainer: string;
    action: string;       // Action slot
    closeButton: string;  // Close button
  };
}
```
