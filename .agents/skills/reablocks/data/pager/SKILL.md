# Pager

Pagination controls with page numbers, navigation arrows, and items range display. Supports three display modes: pages, items, or both.

## Import

```tsx
import { Pager } from 'reablocks';
```

## Pager Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `page` | `number` | — | Current page (0-indexed) |
| `size` | `number` | — | Items per page |
| `total` | `number` | — | Total number of items |
| `displayMode` | `'pages' \| 'items' \| 'all'` | `'pages'` | What to display — page buttons, item range, or both |
| `pageCountToShow` | `number` | `6` | Number of page buttons visible |
| `onPageChange` | `(page: number) => void` | — | Page change callback |
| `startArrow` | `ReactNode \| string` | `<StartArrow />` | First page button icon (set `null` to hide) |
| `endArrow` | `ReactNode \| string` | `<EndArrow />` | Last page button icon (set `null` to hide) |
| `previousArrow` | `ReactNode \| string` | `<PreviousArrow />` | Previous page button icon |
| `nextArrow` | `ReactNode \| string` | `<NextArrow />` | Next page button icon |
| `className` | `string` | — | Container CSS classes |
| `pageClassName` | `string` | — | Per-page button CSS classes |
| `activePageClassName` | `string` | — | Active page button CSS classes |
| `pagesContainerClassName` | `string` | — | Pages container CSS classes |
| `theme` | `PagerTheme` | — | Per-instance theme override |

## Basic Usage

```tsx
const [page, setPage] = useState(0);

<Pager
  page={page}
  size={10}
  total={100}
  onPageChange={setPage}
/>
```

## Display Modes

```tsx
{/* Page numbers only */}
<Pager page={page} size={10} total={100} onPageChange={setPage} displayMode="pages" />

{/* Item range only: "1-10 of 100 items" */}
<Pager page={page} size={10} total={100} onPageChange={setPage} displayMode="items" />

{/* Both page numbers and item range */}
<Pager page={page} size={10} total={100} onPageChange={setPage} displayMode="all" />
```

## Without Start/End Arrows

```tsx
<Pager
  page={page}
  size={10}
  total={100}
  onPageChange={setPage}
  startArrow={null}
  endArrow={null}
/>
```

## PagerTheme Interface

```typescript
interface PagerTheme {
  base: string;              // Container (flex, items-center)
  pages: {
    base: string;            // Pages container (inline-flex)
    page: {
      base: string;          // Individual page button
      active: string;        // Active page button
    };
  };
  ellipsis: string;          // Ellipsis indicator ("...")
  pagerDisplayItems: string; // Items display container
  itemsDisplay: string;      // Items range text
  showPageRange: string;     // Range numbers styling
  totalCount: string;        // Total count styling
  control: string;           // Arrow button styling
  firstPage: string;         // First page button
  prevPage: string;          // Previous page button
  lastPage: string;          // Last page button
  nextPage: string;          // Next page button
}
```
