# Pluralize

Pluralizes text based on count. Wraps the `pluralize` library. Also exports a `pluralize` utility function.

## Import

```tsx
import { Pluralize } from 'reablocks';
// or utility only
import { pluralize } from 'reablocks';
```

## Pluralize Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `count` | `number` | `0` | Number of items |
| `singular` | `string` | — | Singular form of the word |
| `plural` | `string` | — | Custom plural form (auto-pluralized if omitted) |
| `zero` | `string` | — | Custom text when count is 0 |
| `showCount` | `boolean` | `true` | Whether to show the count number |
| `className` | `string` | — | CSS class for the wrapper span |

## Basic Usage

```tsx
<Pluralize count={1} singular="item" />    {/* "1 item" */}
<Pluralize count={5} singular="item" />    {/* "5 items" */}
<Pluralize count={0} singular="item" />    {/* "0 items" */}
```

## Custom Plural

```tsx
<Pluralize count={3} singular="person" plural="people" />  {/* "3 people" */}
```

## Zero State

```tsx
<Pluralize count={0} singular="item" zero="No items" />  {/* "No items" */}
```

## Without Count

```tsx
<Pluralize count={5} singular="item" showCount={false} />  {/* "items" */}
```

## pluralize Utility

```tsx
import { pluralize } from 'reablocks';

pluralize({ count: 5, singular: 'item', showCount: true });    // "5 items"
pluralize({ count: 1, singular: 'person', plural: 'people' }); // "1 person"
pluralize({ count: 0, singular: 'item', zero: 'None' });       // "None"
```
