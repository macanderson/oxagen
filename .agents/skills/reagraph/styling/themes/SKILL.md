# Themes

Light and dark themes with full customization of node, edge, arrow, ring, cluster, lasso, and canvas colors.

## Import

```tsx
import { lightTheme, darkTheme, GraphCanvas } from 'reagraph';
```

## Theme Interface

```ts
interface Theme {
  canvas?: {
    background?: ColorRepresentation;
    fog?: ColorRepresentation | null;
  };
  node: {
    fill: ColorRepresentation;
    activeFill: ColorRepresentation;
    opacity: number;
    selectedOpacity: number;
    inactiveOpacity: number;
    label: {
      color: ColorRepresentation;
      stroke?: ColorRepresentation;
      activeColor: ColorRepresentation;
      backgroundColor?: ColorRepresentation;
      backgroundOpacity?: number;
      padding?: number;
      strokeColor?: ColorRepresentation;
      strokeWidth?: number;
      radius?: number;
    };
    subLabel?: {
      color: ColorRepresentation;
      stroke?: ColorRepresentation;
      activeColor: ColorRepresentation;
    };
  };
  ring: {
    fill: ColorRepresentation;
    activeFill: ColorRepresentation;
  };
  edge: {
    fill: ColorRepresentation;
    activeFill: ColorRepresentation;
    opacity: number;
    selectedOpacity: number;
    inactiveOpacity: number;
    label: {
      color: ColorRepresentation;
      stroke?: ColorRepresentation;
      activeColor: ColorRepresentation;
      fontSize?: number;
    };
    subLabel?: {
      color: ColorRepresentation;
      stroke?: ColorRepresentation;
      activeColor: ColorRepresentation;
      fontSize?: number;
    };
  };
  arrow: {
    fill: ColorRepresentation;
    activeFill: ColorRepresentation;
  };
  lasso: {
    background: string;
    border: string;
  };
  cluster?: {
    stroke?: ColorRepresentation;
    fill?: ColorRepresentation;
    opacity?: number;
    selectedOpacity?: number;
    inactiveOpacity?: number;
    label?: {
      stroke?: ColorRepresentation;
      color: ColorRepresentation;
      fontSize?: number;
      offset?: [number, number, number];
    };
  };
}
```

## Light Theme Defaults

| Section | Property | Value |
|---------|----------|-------|
| canvas | background | `'#fff'` |
| node | fill | `'#7CA0AB'` |
| node | activeFill | `'#1DE9AC'` |
| node | opacity | `1` |
| node | inactiveOpacity | `0.2` |
| node.label | color | `'#2A6475'` |
| node.label | stroke | `'#fff'` |
| edge | fill | `'#D8E6EA'` |
| edge | activeFill | `'#1DE9AC'` |
| edge | inactiveOpacity | `0.1` |
| ring | fill | `'#D8E6EA'` |
| arrow | fill | `'#D8E6EA'` |

## Dark Theme Defaults

| Section | Property | Value |
|---------|----------|-------|
| canvas | background | `'#1E2026'` |
| node | fill | `'#7A8C9E'` |
| node | activeFill | `'#1DE9AC'` |
| node.label | color | `'#ACBAC7'` |
| node.label | stroke | `'#1E2026'` |
| edge | fill | `'#474B56'` |
| edge | activeFill | `'#1DE9AC'` |
| ring | fill | `'#54616D'` |
| arrow | fill | `'#474B56'` |

## Usage

### Light Theme (Default)

```tsx
<GraphCanvas nodes={nodes} edges={edges} />
```

### Dark Theme

```tsx
import { darkTheme } from 'reagraph';

<GraphCanvas nodes={nodes} edges={edges} theme={darkTheme} />
```

### Custom Theme

```tsx
import { lightTheme } from 'reagraph';

const customTheme = {
  ...lightTheme,
  canvas: { background: '#f5f5f5' },
  node: {
    ...lightTheme.node,
    fill: '#4CAF50',
    activeFill: '#FF5722',
  },
  edge: {
    ...lightTheme.edge,
    fill: '#999',
    activeFill: '#FF5722',
  },
};

<GraphCanvas nodes={nodes} edges={edges} theme={customTheme} />
```

### Label Background

```tsx
const themed = {
  ...lightTheme,
  node: {
    ...lightTheme.node,
    label: {
      ...lightTheme.node.label,
      backgroundColor: 'rgba(255, 255, 255, 0.8)',
      padding: 2,
      radius: 0.2,
      strokeColor: '#ddd',
      strokeWidth: 0.5,
    },
  },
};
```

## Per-Node Color Override

Theme colors can be overridden per node/edge via the `fill` property in data:

```tsx
const nodes = [
  { id: '1', label: 'Default Color' },
  { id: '2', label: 'Red', fill: '#FF5722' },
  { id: '3', label: 'Blue', fill: '#2196F3' },
];
```

## Notes

- `activeFill` is used when a node/edge is hovered or selected
- `inactiveOpacity` dims non-selected elements when a selection exists
- `selectedOpacity` is applied to selected elements
- `lasso.background` and `lasso.border` are CSS values (strings with units)
- Spread the base theme and override only what you need
