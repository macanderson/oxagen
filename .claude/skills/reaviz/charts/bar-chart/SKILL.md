# BarChart

Bar chart with gradient fills, labels, and range lines. Supports vertical/horizontal layout with standard, grouped, stacked, stacked-normalized, stacked-diverging, marimekko, waterfall, and histogram variants.

## Import

```tsx
import {
  BarChart,
  BarSeries,
  Bar,
  BarLabel,
  GuideBar,
  RangeLines,
  BarTargetMarker,
  StackedBarChart,
  StackedBarSeries,
  StackedNormalizedBarChart,
  StackedNormalizedBarSeries,
  MarimekkoChart,
  MarimekkoBarSeries,
  HistogramBarChart,
  HistogramBarSeries
} from 'reaviz';
```

## BarChart Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `series` | `ReactElement<BarSeriesProps>` | `<BarSeries />` | Series component |
| `xAxis` | `ReactElement<LinearAxisProps>` | `<LinearXAxis type="category" />` | X axis component |
| `yAxis` | `ReactElement<LinearAxisProps>` | `<LinearYAxis type="value" />` | Y axis component |
| `gridlines` | `ReactElement \| null` | `<GridlineSeries />` | Gridlines (`null` to hide) |
| `brush` | `ReactElement \| null` | `null` | Brush selection component |
| `secondaryAxis` | `ReactElement[]` | — | Additional axis components |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## BarSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `BarType` | `'standard'` | Chart type (see variants below) |
| `layout` | `'vertical' \| 'horizontal'` | `'vertical'` | Bar direction |
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `padding` | `number` | `0.1` | Padding between bars |
| `groupPadding` | `number` | `16` | Padding between groups |
| `bar` | `BarElement \| BarElement[]` | `<Bar />` | Bar element(s) |
| `tooltip` | `ReactElement \| null` | `<TooltipArea />` | Tooltip component |
| `valueMarkers` | `ReactElement<LinearValueMarkerProps>[] \| null` | — | Reference lines at specific values |
| `binSize` | `number` | — | Size of each bin for histogram data |

## Bar Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `gradient` | `ReactElement<GradientProps> \| null` | `<Gradient />` | Gradient fill |
| `mask` | `ReactElement<MaskProps> \| null` | — | SVG pattern mask |
| `rx` | `number` | `0` | Horizontal corner radius |
| `ry` | `number` | `0` | Vertical corner radius |
| `cursor` | `string` | `'auto'` | CSS cursor on hover |
| `minHeight` | `number` | — | Minimum bar height |
| `activeBrightness` | `number` | `0.5` | Brightness increase on hover |
| `glow` | `Glow` | — | Glow effect |
| `label` | `ReactElement<BarLabelProps> \| null` | `null` | Value label on bar |
| `guide` | `ReactElement<GuideBarProps> \| null` | `null` | Background guide bar |
| `rangeLines` | `ReactElement<RangeLinesProps> \| null` | `null` | Range indicator lines |
| `targetMarker` | `ReactElement<BarTargetMarkerProps> \| null` | `<BarTargetMarker />` | Target/goal marker |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | — | Per-bar tooltip |
| `onClick` | `(event: ClickEvent) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

## BarLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `position` | `'top' \| 'center' \| 'bottom'` | `'top'` | Label placement |
| `fill` | `string` | `'#000'` | Text color |
| `fontSize` | `number` | `13` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |
| `padding` | `number` | `5` | Label padding from bar edge |
| `className` | `string` | — | CSS class |

## GuideBar Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fill` | `string` | `'#eee'` | Guide bar fill color |
| `opacity` | `number` | `0.15` | Guide bar opacity |

## RangeLines Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `position` | `'top' \| 'bottom'` | `'top'` | Line placement |
| `strokeWidth` | `number` | `1` | Line thickness |
| `color` | `string` | — | Line color |

## BarTargetMarker Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fill` | `string` | `'#fff'` | Target line color |
| `positiveDeltaFill` | `string` | `'#00C49F'` | Color when above target |
| `negativeDeltaFill` | `string` | `'#FF7361'` | Color when below target |
| `targetStrokeWidth` | `number` | `2` | Target line thickness |
| `deltaStrokeWidth` | `number` | `1` | Delta line thickness |

## Basic Usage

### Single Series (Vertical)

```tsx
const data = [
  { key: 'DLP', data: 13 },
  { key: 'SIEM', data: 2 },
  { key: 'Tic', data: 7 },
];

<BarChart
  width={350}
  height={250}
  data={data}
/>
```

### Horizontal Layout

```tsx
<BarChart
  width={350}
  height={250}
  data={data}
  xAxis={<LinearXAxis type="value" />}
  yAxis={<LinearYAxis type="category" />}
  series={<BarSeries layout="horizontal" />}
/>
```

### Grouped Multi-Series

```tsx
const data = [
  { key: 'Q1', data: [
    { key: 'Sales', data: 10 },
    { key: 'Revenue', data: 15 },
  ]},
  { key: 'Q2', data: [
    { key: 'Sales', data: 25 },
    { key: 'Revenue', data: 20 },
  ]},
];

<BarChart
  width={550}
  height={350}
  data={data}
  series={<BarSeries type="grouped" colorScheme="cybertron" />}
/>
```

### Stacked

```tsx
<StackedBarChart
  width={550}
  height={350}
  data={multiSeriesData}
  series={<StackedBarSeries colorScheme="cybertron" />}
/>
```

### Stacked Normalized (Percentage)

```tsx
<StackedNormalizedBarChart
  width={550}
  height={350}
  data={multiSeriesData}
  series={<StackedNormalizedBarSeries colorScheme="cybertron" />}
/>
```

### Marimekko

```tsx
<MarimekkoChart
  width={550}
  height={350}
  data={multiSeriesData}
  series={<MarimekkoBarSeries colorScheme="cybertron" />}
/>
```

### Histogram

```tsx
<HistogramBarChart
  width={550}
  height={350}
  data={data}
  series={<HistogramBarSeries binSize={25} />}
/>
```

## Customization

### Rounded Corners

```tsx
<BarChart
  data={data}
  series={<BarSeries bar={<Bar rx={4} ry={4} />} />}
/>
```

### Bar Labels

```tsx
<BarChart
  data={data}
  series={
    <BarSeries
      bar={<Bar label={<BarLabel position="top" fill="#333" />} />}
    />
  }
/>
```

### Guide Bars (Hover Background)

```tsx
<BarChart
  data={data}
  series={
    <BarSeries
      bar={<Bar guide={<GuideBar />} />}
    />
  }
/>
```

### Range Lines

```tsx
<BarChart
  data={data}
  series={
    <BarSeries
      bar={<Bar rangeLines={<RangeLines position="top" strokeWidth={3} />} />}
    />
  }
/>
```

### Custom Gradient

```tsx
import { Gradient, GradientStop } from 'reaviz';

<BarChart
  data={data}
  series={
    <BarSeries
      bar={
        <Bar
          gradient={
            <Gradient
              stops={[
                <GradientStop offset="5%" stopOpacity={0.1} />,
                <GradientStop offset="90%" stopOpacity={0.7} />,
              ]}
            />
          }
        />
      }
    />
  }
/>
```

### Pattern Mask

```tsx
import { Stripes } from 'reaviz';

<BarChart
  data={data}
  series={<BarSeries bar={<Bar mask={<Stripes />} />} />}
/>
```

### Custom Padding

```tsx
// Tighter bars
<BarSeries padding={0.05} />

// More spacing
<BarSeries padding={0.3} />

// Group spacing for grouped/stacked
<BarSeries type="grouped" groupPadding={24} />
```

### Value Markers (Reference Lines)

```tsx
import { LinearValueMarker } from 'reaviz';

<BarChart
  data={data}
  series={
    <BarSeries
      valueMarkers={[
        <LinearValueMarker value={50} color="#D740BE" />,
      ]}
    />
  }
/>
```

### Click Handling

```tsx
<BarChart
  data={data}
  series={
    <BarSeries
      bar={
        <Bar
          cursor="pointer"
          onClick={({ value, nativeEvent }) => console.log(value)}
        />
      }
    />
  }
/>
```

### No Gridlines

```tsx
<BarChart data={data} gridlines={null} />
```

## Bar Types

| Type | Data Shape | Description |
|------|-----------|-------------|
| `'standard'` | `ChartDataShape[]` | Single series bars |
| `'grouped'` | `ChartNestedDataShape[]` | Multi-series side by side |
| `'stacked'` | `ChartNestedDataShape[]` | Multi-series stacked |
| `'stackedNormalized'` | `ChartNestedDataShape[]` | Stacked to 100% |
| `'stackedDiverging'` | `ChartNestedDataShape[]` | Diverging from center |
| `'marimekko'` | `ChartNestedDataShape[]` | Proportional area (vertical only) |
| `'waterfall'` | `ChartDataShape[]` | Cumulative running total |

## Variant Components

| Component | Description |
|-----------|-------------|
| `BarChart` | Base chart — all types via `type` prop on series |
| `StackedBarChart` | Pre-configured stacked with range lines |
| `StackedNormalizedBarChart` | Stacked to 100% with percentage Y-axis |
| `MarimekkoChart` | Proportional area chart (vertical only) |
| `HistogramBarChart` | Histogram with bin-based distribution |
| `BarSeries` | Default series |
| `StackedBarSeries` | Series pre-set to `type="stacked"` with range lines |
| `StackedNormalizedBarSeries` | Series pre-set to `type="stackedNormalized"` with percentage tooltips |
| `MarimekkoBarSeries` | Series pre-set to `type="marimekko"` |
| `HistogramBarSeries` | Series for histogram data with range tooltips |
