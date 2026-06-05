# Callout

Inline alert/notification banner with icon and variant colors. Also exports pre-configured variants: SuccessCallout, ErrorCallout, WarningCallout, InfoCallout.

## Import

```tsx
import { Callout, SuccessCallout, ErrorCallout, WarningCallout, InfoCallout } from 'reablocks';
```

## Callout Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `text` | `string \| ReactNode` | — | Callout message content |
| `icon` | `ReactNode` | — | Icon element |
| `variant` | `'default' \| 'success' \| 'error' \| 'warning' \| 'info'` | `'default'` | Color variant |
| `theme` | `CalloutTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<Callout text="This is an informational message" variant="info" icon={<InfoIcon />} />
<Callout text="Operation completed" variant="success" icon={<CheckIcon />} />
<Callout text="Something went wrong" variant="error" icon={<ErrorIcon />} />
<Callout text="Please be careful" variant="warning" icon={<WarningIcon />} />
```

## Pre-configured Variants

```tsx
<SuccessCallout text="Saved successfully" />
<ErrorCallout text="Failed to save" />
<WarningCallout text="Unsaved changes" />
<InfoCallout text="New version available" />
```

## CalloutTheme Interface

```typescript
interface CalloutTheme {
  base: {
    common: string;   // Shared base styles (padding, border-bottom)
    variant: {         // Per-variant background and border colors
      default: string;
      success: string;
      error: string;
      warning: string;
      info: string;
    };
  };
  icon: {
    common: string;    // Shared icon styles
    variant: {         // Per-variant icon colors
      default: string;
      success: string;
      error: string;
      warning: string;
      info: string;
    };
  };
  text: string;        // Text styles
}
```
