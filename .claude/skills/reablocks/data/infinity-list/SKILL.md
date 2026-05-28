# InfinityList

Progressive "show more" list component. Displays an initial batch of items with a button to load more. Also exports `useInfinityList` hook for custom implementations.

## Import

```tsx
import { InfinityList } from 'reablocks';
// or hook only
import { useInfinityList } from 'reablocks';
```

## InfinityList Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | — | Items to display |
| `size` | `number` | `10` | Number of items per page |
| `threshold` | `number` | `3` | Fuzzy threshold — if total items are within `size + threshold`, show all |
| `nextSize` | `number` | — | Items to show on next click (defaults to `size`, use `Infinity` to show all) |
| `buttonClassName` | `string` | — | CSS class for the "Show more" button |

## Basic Usage

```tsx
<InfinityList>
  {items.map(item => (
    <div key={item.id}>{item.name}</div>
  ))}
</InfinityList>
```

## useInfinityList Hook

For custom rendering and control:

```tsx
import { useInfinityList } from 'reablocks';

function MyList({ items }) {
  const { data, hasMore, remaining, showNext } = useInfinityList({
    items,
    size: 10,
    threshold: 3
  });

  return (
    <div>
      {data.map(item => <div key={item.id}>{item.name}</div>)}
      {hasMore && (
        <button onClick={() => showNext()}>
          Show {Math.min(10, remaining)} more
        </button>
      )}
    </div>
  );
}
```

## Hook API

### Inputs

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `items` | `any[]` | — | Array of items |
| `size` | `number` | `10` | Page size |
| `threshold` | `number` | `3` | Fuzzy threshold for showing all remaining |
| `nextSize` | `number` | — | Override next page size (`Infinity` to show all) |

### Returns

| Property | Type | Description |
|----------|------|-------------|
| `data` | `any[]` | Currently visible items |
| `hasMore` | `boolean` | Whether more items exist |
| `remaining` | `number` | Count of remaining items |
| `showNext` | `(amount?: number) => void` | Load next batch |
