# BarList

Horizontal bar list for ranking data. Renders semantic HTML (not SVG) with animated bars, configurable label/value positions, sorting, and percentage mode.

## Import

```tsx
import { BarList, BarListSeries } from 'reaviz';
```

## BarList Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | `[]` | Chart data |
| `type` | `'count' \| 'percent'` | `'count'` | Value scaling — `count` scales to max value, `percent` scales to 100 |
| `sortDirection` | `'asc' \| 'desc' \| 'none'` | `'desc'` | Sort bars by value |
| `series` | `ReactElement<BarListSeriesProps>` | `<BarListSeries />` | Series component |
| `id` | `string` | — | CSS ID |
| `className` | `string` | — | CSS class |
| `style` | `React.CSSProperties` | — | Inline styles |

## BarListSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `labelPosition` | `BarListLabelPosition` | `'top'` | Key label placement |
| `valuePosition` | `BarListLabelPosition` | `'none'` | Value label placement |
| `labelFormat` | `(data, index) => any` | — | Custom label formatter |
| `valueFormat` | `(data, index) => any` | — | Custom value formatter |
| `itemClassName` | `string` | — | CSS class for each bar item |
| `labelClassName` | `string` | — | CSS class for key labels |
| `valueClassName` | `string` | — | CSS class for value labels |
| `barClassName` | `string` | — | CSS class for the inner bar |
| `outerBarClassName` | `string` | — | CSS class for the bar container |
| `onItemClick` | `(data: ChartShallowDataShape) => void` | — | Click handler |
| `onItemMouseEnter` | `(data: ChartShallowDataShape) => void` | — | Mouse enter handler |
| `onItemMouseLeave` | `(data: ChartShallowDataShape) => void` | — | Mouse leave handler |

**BarListLabelPosition**: `'none' | 'top' | 'start' | 'end' | 'bottom'`

## Basic Usage

```tsx
const data = [
  { key: 'Phishing', data: 10 },
  { key: 'Malware', data: 8 },
  { key: 'DDoS', data: 5 },
  { key: 'Ransomware', data: 3 },
];

<BarList data={data} />
```

## With Values Displayed

```tsx
<BarList
  data={data}
  series={<BarListSeries valuePosition="end" />}
/>
```

## Percentage Mode

```tsx
<BarList
  data={data}
  type="percent"
  series={
    <BarListSeries
      valuePosition="end"
      valueFormat={(data) => `${data}%`}
    />
  }
/>
```

## Sort Direction

```tsx
// Ascending (smallest first)
<BarList data={data} sortDirection="asc" />

// Descending (largest first, default)
<BarList data={data} sortDirection="desc" />

// Original data order
<BarList data={data} sortDirection="none" />
```

## Label Positions

```tsx
// Label above bar (default)
<BarListSeries labelPosition="top" />

// Label at start of bar
<BarListSeries labelPosition="start" />

// Label at end of bar
<BarListSeries labelPosition="end" />

// Label below bar
<BarListSeries labelPosition="bottom" />

// No label
<BarListSeries labelPosition="none" />
```

## Click Handling

```tsx
<BarList
  data={data}
  series={
    <BarListSeries
      valuePosition="end"
      onItemClick={(item) => console.log(item)}
    />
  }
/>
```

## Custom Styling

```tsx
<BarList
  data={data}
  series={
    <BarListSeries
      barClassName="rounded-full"
      outerBarClassName="bg-gray-100 rounded-full"
      valueClassName="text-sm font-mono"
    />
  }
/>
```

## Notes

- Renders semantic HTML (`role="list"` / `role="listitem"`), not SVG
- Bars animate with staggered entrance using Framer Motion
- Data is normalized to a 0-100% width range using D3 linear scale
- Each item carries metadata with original `value` and calculated `percent`
