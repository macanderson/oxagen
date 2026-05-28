# DateFormat

Formats dates using date-fns patterns. Supports relative time ("3 hours ago"), toggling between relative and absolute display, and auto-refreshing relative times.

## Import

```tsx
import { DateFormat } from 'reablocks';
```

## DateFormat Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `date` | `Date \| string \| number \| null` | — | The date to format |
| `format` | `string` | `'MM/dd/yy hh:mm:ss a'` | date-fns format string |
| `fromNow` | `boolean` | — | Use relative time display |
| `addSuffix` | `boolean` | `true` | Add suffix to relative time (e.g. "ago") |
| `includeSeconds` | `boolean` | `false` | Include seconds in relative time |
| `allowToggle` | `boolean` | `false` | Allow clicking to toggle relative/absolute |
| `cacheKey` | `string` | — | localStorage key to persist user's toggle preference |
| `emptyMessage` | `string` | `'N/A'` | Displayed when date is null/undefined |
| `className` | `string` | — | Additional CSS classes |
| `theme` | `DateFormatTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
<DateFormat date={new Date()} />
```

## Relative Time

```tsx
<DateFormat date={someDate} fromNow />
{/* Renders: "3 hours ago", "2 days ago", "now" (if < 30 seconds) */}
```

Relative time auto-refreshes: every 60s for < 1 hour, every hour for < 1 day.

## Toggle Between Relative and Absolute

```tsx
<DateFormat date={new Date()} fromNow allowToggle />
{/* Click to toggle between "2 minutes ago" and "04/15/26 02:30:00 PM" */}
```

## String Dates

```tsx
<DateFormat date="2022-05-25T16:03:12.2085" />
```

## Empty State

```tsx
<DateFormat date={null} />                       {/* "N/A" */}
<DateFormat date={null} emptyMessage="No date" /> {/* "No date" */}
```

## DateFormatTheme Interface

```typescript
interface DateFormatTheme {
  base: string;         // Base styles
  interactive: string;  // Styles when allowToggle is true (cursor-pointer, hover:underline)
}
```
