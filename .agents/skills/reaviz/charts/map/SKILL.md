# Map

World map visualization using D3-Geo projections. Renders GeoJSON country features with optional coordinate-based markers and tooltips.

## Import

```tsx
import { Map, MapMarker } from 'reaviz';
```

## Map Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `any` | — | GeoJSON geographic data (required) |
| `markers` | `ReactElement<MapMarkerProps>[]` | — | Array of MapMarker components |
| `fill` | `string` | `'rgba(255, 255, 255, 0.3)'` | Fill color for map regions |
| `projection` | `'mercator' \| 'natural-earth'` | `'mercator'` | Map projection type |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## MapMarker Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `coordinates` | `[number, number]` | — | Geographic `[longitude, latitude]` (required) |
| `index` | `number` | — | Marker index for staggered animation |
| `size` | `number` | `3` | Circle radius |
| `tooltip` | `any` | — | Tooltip content (string or component) |
| `onClick` | `() => void` | — | Click handler |

## Basic Usage

```tsx
import worldData from './worldData.json'; // GeoJSON FeatureCollection

<Map
  height={350}
  width={500}
  data={worldData}
/>
```

## With Markers

```tsx
<Map
  height={350}
  width={500}
  data={worldData}
  markers={[
    <MapMarker
      coordinates={[-122.490402, 37.786453]}
      tooltip="San Francisco"
    />,
    <MapMarker
      coordinates={[-58.3816, -34.6037]}
      tooltip="Buenos Aires"
    />,
    <MapMarker
      coordinates={[-97.7437, 30.2711]}
      tooltip="Austin, TX"
    />,
  ]}
/>
```

## Natural Earth Projection

```tsx
<Map
  data={worldData}
  height={350}
  width={500}
  projection="natural-earth"
/>
```

## Custom Fill

```tsx
<Map
  data={worldData}
  fill="rgba(0, 150, 255, 0.2)"
/>
```

## Autosize

```tsx
<div style={{ width: '80vw', height: '60vh' }}>
  <Map data={worldData} />
</div>
```

## Notes

- Requires GeoJSON data (FeatureCollection) — the component does not bundle map data
- Antarctica (feature id `'010'`) is automatically excluded
- Markers animate in with staggered scale/opacity transitions
- Markers are accessible: include `aria-label`, `tabIndex`, and `role="graphics-document"`
- Coordinates use `[longitude, latitude]` order (D3-Geo convention)
