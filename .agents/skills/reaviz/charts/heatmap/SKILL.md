# Heatmap

Grid-based heatmap with color-scaled cells. Includes a calendar heatmap variant (year and month views). Supports custom symbols, cell selection, tooltips, and multi-axis layouts.

## Import

```tsx
import {
  Heatmap,
  HeatmapSeries,
  HeatmapCell,
  CalendarHeatmap
} from 'reaviz';
```

## Heatmap Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartNestedDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `10` | Chart margins |
| `series` | `ReactElement<HeatmapSeriesProps>` | `<HeatmapSeries padding={0.3} />` | Series component |
| `xAxis` | `ReactElement<LinearAxisProps>` | `<LinearXAxis type="category" />` | X axis (no axis line, padded labels) |
| `yAxis` | `ReactElement<LinearAxisProps>` | `<LinearYAxis type="category" />` | Y axis (no axis line, padded labels) |
| `secondaryAxis` | `ReactElement[]` | — | Additional axis components |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## HeatmapSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `padding` | `number` | `0.1` | Padding between cells |
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | `['rgba(28,107,86,0.5)', '#2da283']` | Color range for value mapping |
| `emptyColor` | `string` | `'rgba(200,200,200,0.08)'` | Color for cells with no data |
| `cell` | `ReactElement<HeatmapCellProps>` | `<HeatmapCell />` | Cell component |
| `selections` | `any` | — | Selected cell(s) for active state |

## HeatmapCell Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `rx` | `number` | `2` | Horizontal corner radius |
| `ry` | `number` | `2` | Vertical corner radius |
| `cursor` | `string` | `'auto'` | CSS cursor on hover |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `symbol` | `(data) => ReactNode` | — | Custom symbol renderer (replaces rectangle) |
| `onClick` | `(event) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

## CalendarHeatmap Props

Extends Heatmap props with:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | — | Flat data with Date keys (not nested) |
| `view` | `'year' \| 'month'` | `'year'` | Calendar view mode |
| `height` | `number` | — | Component height |
| `width` | `number` | — | Component width |

## Basic Usage

```tsx
const data = [
  { key: 'Jan', data: [
    { key: 'Low', data: 5 },
    { key: 'Med', data: 8 },
    { key: 'High', data: 12 },
  ]},
  { key: 'Feb', data: [
    { key: 'Low', data: 3 },
    { key: 'Med', data: 10 },
    { key: 'High', data: 7 },
  ]},
];

<Heatmap
  height={250}
  width={400}
  data={data}
/>
```

## Named Color Scheme

```tsx
<Heatmap
  data={data}
  series={<HeatmapSeries colorScheme="OrRd" />}
/>
```

## Custom Color Range

```tsx
<Heatmap
  data={data}
  series={
    <HeatmapSeries colorScheme={['#f0f9e8', '#08589e']} />
  }
/>
```

## Custom Cell Symbols

```tsx
<Heatmap
  data={data}
  series={
    <HeatmapSeries
      colorScheme="OrRd"
      cell={
        <HeatmapCell
          symbol={() => (
            <circle r={14} transform="translate(14, 14)" />
          )}
        />
      }
    />
  }
/>
```

## Cell Selection

```tsx
const [active, setActive] = useState([]);

<Heatmap
  data={data}
  series={
    <HeatmapSeries
      selections={active}
      cell={
        <HeatmapCell
          cursor="pointer"
          onClick={(e) => setActive([e.value])}
        />
      }
    />
  }
/>
```

## Calendar Heatmap (Year View)

```tsx
const calendarData = [
  { key: new Date('2024-01-01'), data: 3 },
  { key: new Date('2024-01-02'), data: 7 },
  { key: new Date('2024-01-03'), data: 1 },
  // ... one entry per day
];

<CalendarHeatmap
  height={115}
  width={715}
  data={calendarData}
  view="year"
/>
```

## Calendar Heatmap (Month View)

```tsx
<CalendarHeatmap
  height={115}
  width={100}
  data={monthData}
  view="month"
/>
```

## Custom Tooltip Content

```tsx
<HeatmapSeries
  cell={
    <HeatmapCell
      tooltip={
        <ChartTooltip
          content={(d) => `${d.data.key}: ${d.data.value}`}
        />
      }
    />
  }
/>
```

## No Padding (Tight Grid)

```tsx
<Heatmap
  data={data}
  series={<HeatmapSeries padding={0} />}
/>
```

## Notes

- Color scheme maps cell values to a color range using D3 scales
- Named schemes (e.g. `"OrRd"`) from D3 chromatic are supported alongside custom arrays
- Cells animate in with staggered delay based on index
- Tooltips are auto-disabled for transparent/empty cells
- CalendarHeatmap transforms flat `{ key: Date, data: number }` into the nested grid structure internally
- CalendarHeatmap default tooltip shows `"date · value"` format
