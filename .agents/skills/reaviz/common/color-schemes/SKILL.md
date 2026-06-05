# Color Schemes

Built-in color palettes and the `ColorSchemeType` system used by all chart series.

## Import

```tsx
import { schemes } from 'reaviz';
```

## ColorSchemeType

All `colorScheme` props across reaviz accept one of three forms:

```ts
type ColorSchemeType =
  | string              // Named scheme or single color
  | string[]            // Array of colors
  | (data, index, active?) => string;  // Function returning a color
```

## Built-in Palettes

### Reaviz Palettes

| Name | Colors | Description |
|------|--------|-------------|
| `'cybertron'` | 8 colors | Blue-to-green gradient (default for most charts) |
| `'unifyviz'` | 12 colors | Full Unify design system palette |
| `'unifyvizwarm'` | 3 colors | Warm subset (yellow, orange, red) |
| `'unify8Colors'` | 8 colors | Blue-to-green Unify variant |

### D3 Chromatic Palettes

All `chroma.brewer` schemes are available by name:

**Sequential**: `Blues`, `Greens`, `Greys`, `Oranges`, `Purples`, `Reds`, `BuGn`, `BuPu`, `GnBu`, `OrRd`, `PuBu`, `PuBuGn`, `PuRd`, `RdPu`, `YlGn`, `YlGnBu`, `YlOrBr`, `YlOrRd`

**Diverging**: `BrBG`, `PiYG`, `PRGn`, `RdBu`, `RdGy`, `RdYlBu`, `RdYlGn`, `Spectral`

**Categorical**: `Accent`, `Dark2`, `Paired`, `Pastel1`, `Pastel2`, `Set1`, `Set2`, `Set3`

## Usage

### Named Scheme (String)

```tsx
<AreaSeries colorScheme="cybertron" />
<BarSeries colorScheme="Spectral" />
<HeatmapSeries colorScheme="OrRd" />
```

### Single Color

```tsx
<BarSeries colorScheme="rgb(45, 96, 232)" />
<BarSeries colorScheme={schemes.cybertron[0]} />
```

### Color Array

```tsx
<AreaSeries colorScheme={['#FF5722', '#2196F3', '#4CAF50']} />
```

### Function-Based

```tsx
// By index
<AreaSeries colorScheme={(_data, index) => index % 2 ? 'blue' : 'green'} />

// By data value
<ScatterPoint color={(d) => d.metadata?.severity > 5 ? 'red' : 'blue'} />
```

### Accessing Palette Colors Directly

```tsx
import { schemes } from 'reaviz';

// Use first color from cybertron
const primaryColor = schemes.cybertron[0]; // '#2d60e8'

// Use in legend
<DiscreteLegendEntry color={schemes.cybertron[0]} label="Series A" />
<DiscreteLegendEntry color={schemes.cybertron[1]} label="Series B" />
```

## Notes

- `'cybertron'` is the default color scheme for most chart series
- Named D3 palettes are resolved via `chroma.brewer` — case-sensitive names
- For heatmaps, pass a 2-element array for a continuous color range: `['#low', '#high']`
- Function-based schemes receive `(data, index, activeValues?)` and return a CSS color string
