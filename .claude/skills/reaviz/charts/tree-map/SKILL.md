# TreeMap

Rectangular treemap for hierarchical data. Rectangle size is proportional to value. Supports flat and nested data, text wrapping, label placement, and configurable padding.

## Import

```tsx
import { TreeMap, TreeMapSeries, TreeMapRect, TreeMapLabel } from 'reaviz';
```

## TreeMap Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[] \| ChartNestedDataShape[]` | — | Chart data (flat or hierarchical) |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | `0` | Chart margins |
| `paddingInner` | `number` | `5` | Inner padding between rects |
| `paddingOuter` | `number` | `5` | Outer padding |
| `paddingTop` | `number` | `30` | Top padding (title spacing for nested groups) |
| `series` | `ReactElement<TreeMapSeriesProps>` | `<TreeMapSeries />` | Series component |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## TreeMapSeries Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | `'cybertron'` | Color scheme name or function |
| `rect` | `ReactElement<TreeMapRectProps>` | `<TreeMapRect />` | Rectangle element |
| `label` | `ReactElement<TreeMapLabelProps>` | `<TreeMapLabel />` | Label element |

## TreeMapRect Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `cursor` | `string` | `'pointer'` | CSS cursor on hover |
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `onClick` | `(event, data) => void` | — | Click handler |
| `onMouseEnter` | `(event, data) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event, data) => void` | — | Mouse leave handler |

## TreeMapLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `placement` | `'start' \| 'middle' \| 'end'` | `'start'` | Text placement within rect |
| `wrap` | `boolean` | `true` | Wrap long text |
| `fill` | `string` | `'#FFF'` | Text color |
| `fontSize` | `number` | `14` | Font size |
| `fontFamily` | `string` | `'sans-serif'` | Font family |

## Basic Usage

```tsx
const data = [
  { key: 'AWS', data: 100 },
  { key: 'SendGrid', data: 45 },
  { key: 'Okta', data: 75 },
  { key: 'Twilio', data: 25 },
];

<TreeMap
  height={450}
  width={450}
  data={data}
/>
```

## Nested Data

```tsx
const data = [
  { key: 'Windows', data: [
    { key: 'WinXP', data: 15 },
    { key: 'Win10', data: 20 },
    { key: 'Win7', data: 50 },
  ]},
  { key: 'MacOS', data: [
    { key: 'Sierra', data: 20 },
    { key: 'Catalina', data: 30 },
  ]},
];

<TreeMap
  height={450}
  width={450}
  data={data}
/>
```

## Label Placement

```tsx
// Centered labels
<TreeMap
  data={data}
  series={
    <TreeMapSeries
      label={<TreeMapLabel placement="middle" />}
    />
  }
/>

// End-aligned labels
<TreeMap
  data={data}
  series={
    <TreeMapSeries
      label={<TreeMapLabel placement="end" />}
    />
  }
/>
```

## No Text Wrapping

```tsx
<TreeMap
  data={data}
  series={
    <TreeMapSeries
      label={<TreeMapLabel wrap={false} />}
    />
  }
/>
```

## Click Handling

```tsx
<TreeMap
  data={data}
  series={
    <TreeMapSeries
      rect={
        <TreeMapRect
          onClick={(event, d) => console.log(d)}
        />
      }
    />
  }
/>
```

## Custom Color Scheme

```tsx
<TreeMap
  data={data}
  series={
    <TreeMapSeries colorScheme={['#FF5722', '#2196F3', '#4CAF50']} />
  }
/>
```

## Tight Layout (No Padding)

```tsx
<TreeMap
  data={data}
  paddingInner={0}
  paddingOuter={0}
  paddingTop={0}
/>
```

## No Animation

```tsx
<TreeMap
  data={data}
  series={<TreeMapSeries animated={false} />}
/>
```

## Notes

- Uses D3 treemap layout to compute rectangle positions and sizes
- Nested data renders group titles using `paddingTop` space
- Text color is automatically inverted based on background darkness for contrast
- Labels wrap within rectangle bounds by default
- Tooltip shows hierarchical path and value for nested data
