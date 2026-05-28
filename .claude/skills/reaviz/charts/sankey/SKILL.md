# Sankey

Flow diagram showing weighted connections between nodes. Built on D3-Sankey with gradient links, interactive highlighting, configurable label positioning, and node justification.

## Import

```tsx
import { Sankey, SankeyNode, SankeyLink, SankeyLabel } from 'reaviz';
```

## Sankey Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `nodes` | `ReactElement<SankeyNodeProps>[]` | — | Node elements (required) |
| `links` | `ReactElement<SankeyLinkProps>[]` | — | Link elements (required) |
| `width` | `number` | auto | Width in pixels |
| `height` | `number` | auto | Height in pixels |
| `margins` | `Margins` | — | Chart margins |
| `animated` | `boolean` | `true` | Enable animations |
| `colorScheme` | `ColorSchemeType` | — | Color scheme for nodes |
| `justification` | `'justify' \| 'center' \| 'left' \| 'right'` | `'justify'` | Node alignment method |
| `nodeWidth` | `number` | `15` | Width of each node |
| `nodePadding` | `number` | `10` | Vertical padding between nodes |
| `labelPosition` | `'inside' \| 'outside'` | `'inside'` | Label placement |
| `nodeSort` | `(a, b) => number` | — | Custom node sort function |
| `className` | `string` | — | SVG CSS class |
| `containerClassName` | `string` | — | Container div CSS class |

## SankeyNode Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `title` | `string` | — | Node title (required) |
| `id` | `string` | — | Node ID (falls back to index) |
| `color` | `string` | `'rgba(255, 255, 255, 0.2)'` | Node color |
| `animated` | `boolean` | `true` | Enable animations |
| `disabled` | `boolean` | `false` | Disable the node |
| `label` | `ReactElement<SankeyLabelProps>` | `<SankeyLabel />` | Label element |
| `tooltip` | `ReactElement \| null` | `<Tooltip />` | Tooltip element |
| `opacity` | `(active, disabled) => number` | active: 1, disabled: 0.2, default: 0.9 | Opacity callback |
| `className` | `string` | — | CSS class |
| `style` | `React.StyleHTMLAttributes` | — | Inline styles |
| `onClick` | `(event) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

## SankeyLink Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `source` | `string \| number` | — | Source node ID or index |
| `target` | `string \| number` | — | Target node ID or index |
| `value` | `number` | — | Link weight/value |
| `color` | `string` | — | Link color (defaults to source node color) |
| `gradient` | `boolean` | `true` | Use gradient from source to target color |
| `animated` | `boolean` | `true` | Enable animations |
| `disabled` | `boolean` | `false` | Disable the link |
| `tooltip` | `ReactElement \| null` | `<Tooltip />` | Tooltip element |
| `opacity` | `(active, disabled) => number` | active: 0.5, disabled: 0.1, default: 0.35 | Opacity callback |
| `className` | `string` | — | CSS class |
| `style` | `object` | — | Inline styles |
| `onClick` | `(event) => void` | — | Click handler |
| `onMouseEnter` | `(event) => void` | — | Mouse enter handler |
| `onMouseLeave` | `(event) => void` | — | Mouse leave handler |

## SankeyLabel Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `position` | `'inside' \| 'outside'` | `'inside'` | Label placement |
| `fill` | `string` | `'#fff'` | Text color |
| `visible` | `boolean` | `true` | Show/hide the label |
| `ellipsis` | `number \| 'none' \| 'auto'` | `'auto'` | Truncation (`'auto'` based on width, number for char limit) |
| `format` | `(props: SankeyLabelFormatProps) => any` | — | Custom label renderer |
| `opacity` | `(active, disabled) => number` | active: 1, disabled: 0.2, default: 0.9 | Opacity callback |
| `padding` | `string \| number` | — | Padding between label and node |
| `className` | `string` | — | CSS class |

## Basic Usage

```tsx
const nodes = [
  { title: 'Email' },
  { title: 'Social' },
  { title: 'Landing Page' },
  { title: 'Signup' },
  { title: 'Purchase' },
];

const links = [
  { source: 0, target: 3, value: 50 },
  { source: 1, target: 3, value: 30 },
  { source: 2, target: 3, value: 20 },
  { source: 3, target: 4, value: 70 },
];

<Sankey
  height={300}
  width={550}
  nodes={nodes.map((node, i) => (
    <SankeyNode key={`node-${i}`} {...node} />
  ))}
  links={links.map((link, i) => (
    <SankeyLink key={`link-${i}`} {...link} />
  ))}
/>
```

## With Color Scheme and Outside Labels

```tsx
<Sankey
  height={300}
  width={550}
  colorScheme="Spectral"
  nodeWidth={5}
  labelPosition="outside"
  nodes={nodes.map((node, i) => (
    <SankeyNode key={`node-${i}`} {...node} />
  ))}
  links={links.map((link, i) => (
    <SankeyLink key={`link-${i}`} {...link} />
  ))}
/>
```

## Click Handling

```tsx
<Sankey
  height={300}
  width={550}
  nodes={nodes.map((node, i) => (
    <SankeyNode
      key={`node-${i}`}
      {...node}
      onClick={() => console.log(node.title)}
    />
  ))}
  links={links.map((link, i) => (
    <SankeyLink
      key={`link-${i}`}
      {...link}
      onClick={() => console.log(link)}
    />
  ))}
/>
```

## Custom Node Colors

```tsx
const nodes = [
  { title: 'Email', color: '#FF5722' },
  { title: 'Social', color: '#2196F3' },
  { title: 'Signup', color: '#4CAF50' },
];
```

## No Gradient Links

```tsx
<SankeyLink gradient={false} color="#999" />
```

## Custom Label Format

```tsx
<SankeyNode
  title="Email"
  label={
    <SankeyLabel
      format={({ node }) => `${node.title} (${node.value})`}
    />
  }
/>
```

## Label Ellipsis Control

```tsx
// Auto-truncate based on available width (default)
<SankeyLabel ellipsis="auto" />

// No truncation
<SankeyLabel ellipsis="none" />

// Truncate at specific character count
<SankeyLabel ellipsis={15} />
```

## Justification Options

```tsx
// Nodes spread across full width (default)
<Sankey justification="justify" />

// Left-aligned
<Sankey justification="left" />

// Center-aligned
<Sankey justification="center" />

// Right-aligned
<Sankey justification="right" />
```

## Notes

- Hovering a node highlights it and all connected links/nodes; non-connected elements dim
- Hovering a link highlights it and its source/target nodes
- Links use SVG gradient fills by default, transitioning from source to target node color
- `nodes` and `links` must be passed as arrays of JSX elements, not raw data
- Node positions are computed by D3-Sankey layout — `source`/`target` in links reference node indices or IDs
- Label auto-ellipsis truncates at 10 characters max when space is limited
