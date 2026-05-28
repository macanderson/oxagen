# Redact

Masks sensitive content with a configurable character, keeping first and last characters visible. Click to toggle visibility.

## Import

```tsx
import { Redact } from 'reablocks';
```

## Redact Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `string` | — | Text to mask |
| `allowToggle` | `boolean` | `true` | Allow clicking to reveal/hide content |
| `compactLength` | `number` | `8` | Number of characters in masked output |
| `character` | `string` | `'*'` | Masking character |
| `tooltipText` | `string` | `'Click to toggle sensitive content'` | Hover title text |
| `className` | `string` | — | Additional CSS classes |
| `theme` | `RedactTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<Redact value="my-secret-api-key-12345" />
{/* Renders: "m******5" — click to toggle */}
```

## Non-Toggleable

```tsx
<Redact value="sensitive-data" allowToggle={false} />
{/* Always masked, not clickable */}
```

## Custom Masking

```tsx
<Redact value="secret" character="•" compactLength={6} />
{/* "s••••t" */}
```

## RedactTheme Interface

```typescript
interface RedactTheme {
  base: string;         // Base styles (cursor-text)
  interactive: string;  // Styles when allowToggle is true (cursor-pointer, hover:underline)
}
```
