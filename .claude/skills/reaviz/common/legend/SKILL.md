# Legend

Chart legends for identifying data series. `DiscreteLegend` for categorical series; `SequentialLegend` for continuous color scales.

## Import

```tsx
import {
  DiscreteLegend,
  DiscreteLegendEntry,
  DiscreteLegendSymbol,
  SequentialLegend
} from 'reaviz';
```

## DiscreteLegend Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `entries` | `ReactElement<DiscreteLegendEntryProps>[]` | — | Legend entries (required) |
| `orientation` | `'horizontal' \| 'vertical'` | `'vertical'` | Layout direction |
| `className` | `string` | — | CSS class |
| `style` | `React.CSSProperties` | — | Inline styles |

## DiscreteLegendEntry Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `label` | `string` | — | Entry label (required) |
| `color` | `string` | — | Entry color (required) |
| `symbol` | `ReactElement \| ReactNode` | `<DiscreteLegendSymbol />` | Symbol element |
| `title` | `string` | — | HTML title attribute |
| `className` | `string` | — | CSS class |
| `style` | `React.CSSProperties` | — | Inline styles |
| `onClick` | `(event) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

## DiscreteLegendSymbol Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `color` | `string` | — | Symbol color (set by entry) |
| `className` | `string` | — | CSS class |

## SequentialLegend Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartDataShape[]` | — | Data for scale extent (required) |
| `colorScheme` | `string[]` | `['rgba(28,107,86,0.5)', '#2da283']` | Color range |
| `orientation` | `'horizontal' \| 'vertical'` | `'vertical'` | Layout direction |
| `className` | `string` | — | CSS class |
| `gradientClassName` | `string` | — | CSS class for gradient element |
| `style` | `any` | — | Inline styles |

## Discrete Legend

```tsx
<DiscreteLegend
  orientation="horizontal"
  entries={[
    <DiscreteLegendEntry label="Series A" color="#2d60e8" />,
    <DiscreteLegendEntry label="Series B" color="#26efb5" />,
    <DiscreteLegendEntry label="Series C" color="#ff5722" />,
  ]}
/>
```

## Vertical Legend

```tsx
<DiscreteLegend
  orientation="vertical"
  entries={[
    <DiscreteLegendEntry label="Revenue" color="#2d60e8" />,
    <DiscreteLegendEntry label="Costs" color="#ff5722" />,
  ]}
/>
```

## Interactive Legend (Toggle Series)

```tsx
const [active, setActive] = useState(['A', 'B']);

<DiscreteLegend
  entries={series.map((s) => (
    <DiscreteLegendEntry
      key={s.key}
      label={s.key}
      color={s.color}
      style={{ opacity: active.includes(s.key) ? 1 : 0.3 }}
      onClick={() =>
        setActive((prev) =>
          prev.includes(s.key)
            ? prev.filter((k) => k !== s.key)
            : [...prev, s.key]
        )
      }
    />
  ))}
/>
```

## Sequential Legend (Heatmap)

```tsx
<SequentialLegend
  data={heatmapData}
  colorScheme={['#f0f9e8', '#08589e']}
  orientation="vertical"
/>
```

## Horizontal Sequential Legend

```tsx
<SequentialLegend
  data={data}
  orientation="horizontal"
  colorScheme={['rgba(28,107,86,0.5)', '#2da283']}
/>
```

## Notes

- Legends are **not** automatically rendered by charts — add them alongside your chart component
- `DiscreteLegend` renders HTML elements (not SVG), so place it outside the chart SVG
- `SequentialLegend` renders a gradient bar with min/max labels from the data extent
