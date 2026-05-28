---
name: reaviz
description: Use when building charts or data visualizations in React with the reaviz library (AreaChart, BarChart, LineChart, PieChart, ScatterPlot, Heatmap, Sankey, RadarChart, etc.). Covers composable chart architecture, data shapes, axes, gridlines, tooltips, color schemes, and animation.
---

# Reaviz

Reaviz is a React data visualization library built on **D3.js** and **Framer Motion**. It provides composable, animated chart components with a declarative JSX API.

## Installation

```bash
npm install reaviz
```

## Core Concepts

### Composable Chart Architecture

Every chart follows the same pattern: a top-level chart component wraps axis, series, gridline, and interaction sub-components. Sub-components are passed as JSX element props, making each layer independently configurable:

```tsx
import { AreaChart, AreaSeries, LinearXAxis, LinearYAxis, GridlineSeries } from 'reaviz';

<AreaChart
  data={data}
  xAxis={<LinearXAxis type="time" />}
  yAxis={<LinearYAxis type="value" />}
  series={<AreaSeries interpolation="smooth" />}
  gridlines={<GridlineSeries />}
/>
```

### Data Shapes

**Single series** — `ChartDataShape[]`:
```ts
{ key: Date | string | number, data: number }
```

**Multi / nested series** — `ChartNestedDataShape[]`:
```ts
{ key: Date | string | number, data: { key: string, data: number }[] }
```

### Common Chart Props

All chart components share these base props:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins `{ top, right, bottom, left }` |
| `className` | `string` | — | CSS class for the SVG element |
| `containerClassName` | `string` | — | CSS class for the container div |

### Shared Infrastructure

| Module | Description |
|--------|-------------|
| **LinearXAxis / LinearYAxis** | Configurable axes with tick formatting, types (`time`, `value`, `category`, `duration`) |
| **GridlineSeries** | Background gridlines and stripes |
| **Gradient / GradientStop** | SVG gradient fills for areas and bars |
| **Mask / Stripes** | SVG pattern masks |
| **TooltipArea / ChartTooltip** | Hover tooltips with customizable templates |
| **ChartBrush** | Range selection brush for filtering |
| **ChartZoomPan** | Zoom and pan interaction |
| **LinearValueMarker** | Horizontal/vertical reference lines at specific values |
| **MarkLine** | Crosshair mark line on hover |

### Color Schemes

Pass a built-in scheme name or a custom function to `colorScheme`:

```tsx
// Built-in
<AreaSeries colorScheme="cybertron" />

// Custom function
<AreaSeries colorScheme={(_data, index) => index % 2 ? 'blue' : 'green'} />
```

### Interpolation Types

Applies to area and line charts:

`'linear'` | `'smooth'` | `'step'` | `'monotone'` | `'natural'` | `'basis'` | `'cardinal'`

### Animation

All series components accept `animated: boolean` (default `true`). Framer Motion handles enter, update, and exit transitions.

## Chart Index

### Cartesian Charts
AreaChart, BarChart, LineChart, ScatterPlot, BubbleChart, Heatmap, FunnelChart, BarList, Sparkline

### Radial Charts
RadialAreaChart, RadialBarChart, RadialGauge, RadialScatterPlot, RadarChart, PieChart, SunburstChart

### Other
Sankey, VennDiagram, TreeMap, LinearGauge, Meter, Map, WordCloud

## Common Patterns

- **Import from barrel**: Always `import { Component } from 'reaviz'`
- **Auto-sizing**: Omit `width` / `height` and the chart fills its container
- **Customizing sub-components**: Override defaults by passing a configured JSX element (e.g. `series={<AreaSeries interpolation="smooth" />}`)
- **Disabling features**: Pass `null` to remove a sub-component (e.g. `gridlines={null}`)
