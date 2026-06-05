# ScatterPlot

Scatter plot with configurable point size, color, custom symbols, and optional bubble sizing. Supports time, value, and category axes with brush, zoom/pan, and value markers.

## Import

```tsx
import { ScatterPlot, ScatterSeries, ScatterPoint } from 'reaviz';
```

## ScatterPlot Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `series` | `ReactElement<ScatterSeriesProps>` | `<ScatterSeries />` | Series component |
| `xAxis` | `ReactElement<LinearAxisProps>` | `<LinearXAxis type="time" />` | X axis component |
| `yAxis` | `ReactElement<LinearAxisProps>` | `<LinearYAxis type="value" />` | Y axis component |
| `gridlines` | `ReactElement \| null` | `<GridlineSeries />` | Gridlines (`null` to hide) |
| `brush` | `ReactElement \| null` | `null` | Brush selection component |
| `zoomPan` | `ReactElement \| null` | `null` | Zoom/pan component |
| `secondaryAxis` | `ReactElement[]` | — | Additional axis components |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## ScatterSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `point` | `ReactElement<ScatterPointProps>` | `<ScatterPoint />` | Point element |
| `animated` | `boolean` | `true` | Enable animations |
| `activeIds` | `string[]` | — | Active element IDs to highlight |
| `valueMarkers` | `ReactElement<LinearValueMarkerProps>[] \| null` | — | Reference lines at specific values |

## ScatterPoint Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `number \| (data) => number` | `4` | Point radius (or function for bubble sizing) |
| `color` | `ColorSchemeType` | `schemes.cybertron[0]` | Point color (string, array, or function) |
| `cursor` | `string` | `'pointer'` | CSS cursor on hover |
| `animated` | `boolean` | `true` | Enable animations |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `glow` | `Glow` | — | Glow effect |
| `symbol` | `(data) => ReactNode` | — | Custom symbol renderer (replaces circle) |
| `visible` | `(data, index) => boolean` | — | Conditional visibility per point |
| `onClick` | `(data) => void` | — | Click handler |
| `onMouseEnter` | `(data) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(data) => void` | — | Mouse leave handler |
| `className` | `string` | — | CSS class |
| `style` | `any` | — | Inline styles |

## Basic Usage

```tsx
const data = [
  { key: new Date('2024-01-01'), data: 10 },
  { key: new Date('2024-02-01'), data: 25 },
  { key: new Date('2024-03-01'), data: 18 },
];

<ScatterPlot
  height={400}
  width={750}
  data={data}
/>
```

## Bubble Chart (Dynamic Size)

```tsx
<ScatterPlot
  height={400}
  width={750}
  data={data}
  margins={20}
  series={
    <ScatterSeries
      point={
        <ScatterPoint
          color="rgba(45, 96, 232, 0.8)"
          size={(v) => v.metadata.severity + 5}
        />
      }
    />
  }
/>
```

## Custom Color

```tsx
<ScatterPlot
  data={data}
  series={
    <ScatterSeries
      point={<ScatterPoint color="#FF5722" size={6} />}
    />
  }
/>
```

## Custom Symbols

```tsx
import { symbol, symbolStar } from 'd3-shape';

<ScatterPlot
  data={data}
  series={
    <ScatterSeries
      point={
        <ScatterPoint
          symbol={() => {
            const d = symbol().type(symbolStar).size(175)();
            return (
              <path
                d={d}
                style={{ fill: 'lime', stroke: 'purple', strokeWidth: 1.5 }}
              />
            );
          }}
        />
      }
    />
  }
/>
```

## Value Markers (Reference Lines)

```tsx
import { LinearValueMarker } from 'reaviz';

<ScatterPlot
  data={data}
  series={
    <ScatterSeries
      point={<ScatterPoint color={schemes.cybertron[0]} size={4} />}
      valueMarkers={[
        <LinearValueMarker value={2} color="#D740BE" />,
        <LinearValueMarker value={5} color="#F8A340" />,
      ]}
    />
  }
/>
```

## Categorical Y-Axis

```tsx
const stages = ['Stage 1', 'Stage 2', 'Stage 3'];

<ScatterPlot
  data={data}
  yAxis={
    <LinearYAxis
      type="category"
      domain={stages}
    />
  }
/>
```

## Click Handling

```tsx
<ScatterPlot
  data={data}
  series={
    <ScatterSeries
      point={
        <ScatterPoint
          onClick={(d) => console.log(d)}
        />
      }
    />
  }
/>
```

## Conditional Visibility

```tsx
<ScatterPlot
  data={data}
  series={
    <ScatterSeries
      point={
        <ScatterPoint
          visible={(d) => d.value > 10}
        />
      }
    />
  }
/>
```

## No Gridlines

```tsx
<ScatterPlot data={data} gridlines={null} />
```

## Notes

- Default cursor is `'pointer'` (unlike other chart types that default to `'auto'`)
- `size` accepts a function for bubble-chart behavior — receives the data point, return a radius
- `symbol` replaces the default circle with any SVG element (D3 symbols, icons, etc.)
- `visible` callback allows filtering individual points without modifying data
- `color` supports `ColorSchemeType`: a single color string, an array, or a `(data, index) => string` function
