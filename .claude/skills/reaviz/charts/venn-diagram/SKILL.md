# VennDiagram

Venn and Euler diagram showing set intersections. Three layout types: standard Venn, proportional Euler, and Star Euler. Supports selections, custom styling per state, and inner/outer labels.

## Import

```tsx
import {
  VennDiagram,
  VennSeries,
  VennArc,
  VennLabel,
  VennOuterLabel
} from 'reaviz';
```

## VennDiagram Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `VennDiagramData[]` | — | Chart data (required) |
| `type` | `'venn' \| 'euler' \| 'starEuler'` | `'venn'` | Layout algorithm |
| `disabled` | `boolean` | `false` | Disable the chart |
| `series` | `ReactElement<VennSeriesProps> \| null` | `<VennSeries />` | Series component |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

### VennDiagramData

```ts
interface VennDiagramData {
  key: string[];   // Set names (e.g. ['A'] or ['A', 'B'] for intersection)
  data: number;    // Size of set/intersection
}
```

## VennSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme |
| `disabled` | `boolean` | `false` | Disable interactions |
| `selections` | `string[]` | — | Active selection keys (e.g. `['A|B']`) |
| `arc` | `ReactElement<VennArcProps> \| null` | `<VennArc />` | Arc element |
| `label` | `ReactElement<VennLabelProps> \| null` | `<VennLabel />` | Inner label element |
| `outerLabel` | `ReactElement<VennOuterLabelProps> \| null` | `<VennOuterLabel />` | Outer label element |

## VennArc Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `strokeWidth` | `number` | `3` | Stroke thickness |
| `stroke` | `string \| (data, index, isActive, isHovered) => string` | — | Stroke color or function |
| `gradient` | `ReactElement<GradientProps> \| null` | `<Gradient />` | Gradient fill |
| `mask` | `ReactElement<MaskProps> \| null` | — | SVG pattern mask |
| `glow` | `Glow` | — | Glow effect |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `initialStyle` | `object` | `{ opacity: 0.6 }` | Default arc style |
| `activeStyle` | `object` | `{ opacity: 0.8 }` | Style when selected |
| `inactiveStyle` | `object` | `{ opacity: 0.3 }` | Style when other arcs are active |
| `style` | `object` | — | Custom CSS styles |
| `disabled` | `boolean` | — | Disable interactions |
| `onClick` | `(event) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

## VennLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `labelType` | `'key' \| 'value'` | `'key'` | Show set name or value |
| `showAll` | `boolean` | `false` | Show labels for small intersections too |
| `wrap` | `boolean` | `true` | Wrap long text |
| `fill` | `string` | — | Text color |
| `fontSize` | `number` | `11` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `animated` | `boolean` | `true` | Enable animations |
| `format` | `(data) => any` | — | Custom label formatter |

## VennOuterLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fill` | `string` | `'#000'` | Text color |
| `fontSize` | `number` | `14` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `animated` | `boolean` | `true` | Enable animations |
| `format` | `(data) => any` | — | Custom label formatter |

## Basic Usage

```tsx
const data = [
  { key: ['A'], data: 12 },
  { key: ['B'], data: 12 },
  { key: ['A', 'B'], data: 2 },
];

<VennDiagram
  height={450}
  width={450}
  data={data}
/>
```

## Three Sets

```tsx
const data = [
  { key: ['A'], data: 12 },
  { key: ['B'], data: 12 },
  { key: ['C'], data: 8 },
  { key: ['A', 'B'], data: 2 },
  { key: ['A', 'C'], data: 3 },
  { key: ['B', 'C'], data: 1 },
  { key: ['A', 'B', 'C'], data: 1 },
];

<VennDiagram
  height={450}
  width={450}
  data={data}
/>
```

## Euler Layout (Proportional)

```tsx
<VennDiagram
  type="euler"
  height={450}
  width={450}
  data={data}
/>
```

## Star Euler Layout

```tsx
<VennDiagram
  type="starEuler"
  height={450}
  width={450}
  data={data}
  series={
    <VennSeries
      colorScheme={['#868686']}
      arc={<VennArc strokeWidth={1} stroke="#fff" gradient={<Gradient />} />}
      label={<VennLabel labelType="value" showAll={true} fill="#fff" />}
      outerLabel={<VennOuterLabel fill="#fff" />}
    />
  }
/>
```

## Value Labels

```tsx
<VennDiagram
  data={data}
  series={
    <VennSeries
      label={<VennLabel labelType="value" />}
    />
  }
/>
```

## Managed Selections

```tsx
<VennDiagram
  data={data}
  series={
    <VennSeries
      selections={['A|B', 'B']}
    />
  }
/>
```

## Dynamic Stroke Color

```tsx
<VennDiagram
  data={data}
  series={
    <VennSeries
      arc={
        <VennArc
          stroke={(_data, _index, active, hovered) => {
            if (hovered) return 'blue';
            if (active) return 'green';
            return 'white';
          }}
        />
      }
    />
  }
/>
```

## Notes

- `type="venn"` — equal-sized circles with overlapping intersections
- `type="euler"` — circle sizes proportional to set values
- `type="starEuler"` — star-shaped layout for many overlapping sets
- `selections` uses pipe-delimited keys (e.g. `'A|B'` for the intersection of A and B)
- Inner labels show on sufficiently large regions by default; use `showAll` to force display
- Outer labels appear around the diagram perimeter showing set names
- Arc opacity transitions between `initialStyle`, `activeStyle`, and `inactiveStyle` based on hover/selection state
