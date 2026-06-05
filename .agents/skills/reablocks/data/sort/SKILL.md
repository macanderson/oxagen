# Sort

Sortable column header utility with animated direction indicators. Cycles through `asc` → `desc` → `null` (unsorted). Built on Framer Motion.

## Import

```tsx
import { Sort } from 'reablocks';
// also available
import { getNextDirection, SortDirection } from 'reablocks';
```

## Sort Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `direction` | `'asc' \| 'desc' \| null` | — | Current sort direction |
| `onSort` | `(direction: SortDirection) => void` | — | Sort change callback |
| `disabled` | `boolean` | — | Disable sorting |
| `icon` | `React.ComponentType<{ className?: string }>` | `DownArrowIcon` | Sort direction icon |
| `neutralIcon` | `React.ComponentType<{ className?: string }>` | — | Icon shown when unsorted |
| `className` | `string` | — | Container CSS classes |
| `iconClassName` | `string` | — | Direction icon CSS classes |
| `neutralIconClassName` | `string` | — | Neutral icon CSS classes |
| `theme` | `SortTheme` | — | Per-instance theme override |
| `children` | `ReactNode` | — | Column header content |

## Basic Usage

```tsx
const [direction, setDirection] = useState<SortDirection>(null);

<Sort direction={direction} onSort={setDirection}>
  Column Name
</Sort>
```

## Sort Cycle

Clicking cycles: `null` → `'asc'` → `'desc'` → `null`

The ascending icon is the default icon rotated 180°. The descending icon is the default icon as-is.

## getNextDirection Utility

```tsx
import { getNextDirection } from 'reablocks';

getNextDirection(null);        // 'asc'
getNextDirection('asc');       // 'desc'
getNextDirection('desc');      // null
getNextDirection('desc', 'asc', false); // 'asc' (canBeNull=false skips null)
```

Signature: `getNextDirection(direction?, defaultDirection='asc', canBeNull=true)`

## SortTheme Interface

```typescript
interface SortTheme {
  base: string;       // Container (cursor-pointer, flex, items-center)
  disabled: string;   // Disabled state
  hasValue: string;   // Disabled but has a direction value (cursor-not-allowed)
  icon: {
    base: string;     // Icon base (size, fill, margin)
    ascending: string; // Ascending modifier (rotate-180)
  };
}
```
