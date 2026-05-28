# WordCloud

Tag cloud visualization using D3-Cloud layout. Word size is proportional to data value. Supports rotation, custom font sizing, color schemes, and tooltips.

## Import

```tsx
import { WordCloud, WordCloudLabel } from 'reaviz';
```

## WordCloud Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `ChartShallowDataShape[]` | `[]` | Chart data |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `fontSizeRange` | `[number, number]` | `[12, 50]` | Min/max font size range |
| `fontFamily` | `string` | `'Arial'` | Font family |
| `padding` | `number` | `3` | Padding between words |
| `rotationAngles` | `[number, number]` | `[-30, 30]` | Min/max rotation angle range |
| `rotations` | `number` | `2` | Number of rotation steps |
| `colorScheme` | `string[]` | `schemes.cybertron` | Array of color strings |
| `margins` | `Margins` | — | Chart margins |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |
| `onLabelClick` | `(event, data) => void` | — | Word click handler |
| `onLabelMouseEnter` | `(event, data) => void` | — | Word mouse enter handler |
| `onLabelMouseLeave` | `(event, data) => void` | — | Word mouse leave handler |

## WordCloudLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `tooltip` | `ReactElement<ChartTooltipProps> \| null` | `<ChartTooltip />` | Tooltip component |
| `className` | `string` | — | CSS class |
| `onClick` | `(event, data) => void` | — | Click handler |
| `onMouseEnter` | `(event, data) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event, data) => void` | — | Mouse leave handler |

## Basic Usage

```tsx
const data = [
  { key: 'React', data: 100 },
  { key: 'JavaScript', data: 85 },
  { key: 'TypeScript', data: 75 },
  { key: 'Node.js', data: 60 },
  { key: 'CSS', data: 50 },
  { key: 'HTML', data: 45 },
  { key: 'Python', data: 40 },
];

<WordCloud
  width={600}
  height={400}
  data={data}
/>
```

## Custom Font Size Range

```tsx
<WordCloud
  width={600}
  height={400}
  data={data}
  fontSizeRange={[20, 80]}
/>
```

## No Rotation

```tsx
<WordCloud
  width={600}
  height={400}
  data={data}
  rotations={0}
/>
```

## Single Color

```tsx
<WordCloud
  width={600}
  height={400}
  data={data}
  colorScheme={['white']}
/>
```

## Custom Colors

```tsx
<WordCloud
  width={600}
  height={400}
  data={data}
  colorScheme={['#FF5722', '#2196F3', '#4CAF50', '#FFC107']}
/>
```

## Click Handling

```tsx
<WordCloud
  width={600}
  height={400}
  data={data}
  onLabelClick={(event, d) => console.log(d.key)}
/>
```

## Notes

- Uses D3-Cloud for word placement — words are positioned to avoid overlaps
- Font size scales linearly from `fontSizeRange[0]` to `fontSizeRange[1]` based on data value
- `rotations` controls how many discrete rotation angles are used within the `rotationAngles` range; set to `0` for horizontal-only
- Words animate in with opacity transitions and hover at 0.7 opacity
- Cursor changes to pointer when a click handler is provided
- Tooltip shows word text and value on hover
