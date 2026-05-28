# Tree

Hierarchical tree view with expandable/collapsible nodes, custom icons, and animated transitions. Composed of Tree and TreeNode. Uses Collapse for expand/collapse animation.

## Import

```tsx
import { Tree, TreeNode } from 'reablocks';
```

## Tree Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `expandedIcon` | `ReactNode` | `<ArrowDownIcon />` | Icon for expanded nodes |
| `collapsedIcon` | `ReactNode` | `<ArrowRightIcon />` | Icon for collapsed nodes |
| `className` | `string` | — | Container CSS classes |
| `style` | `CSSProperties` | — | Inline styles |
| `theme` | `TreeTheme` | — | Per-instance theme override |

Icons are provided to all TreeNodes via React Context.

## TreeNode Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `label` | `ReactNode \| string` | — | Node label |
| `expanded` | `boolean` | — | Controlled expanded state |
| `disabled` | `boolean` | — | Disable expand/collapse |
| `className` | `string` | — | Node CSS classes |
| `onExpand` | `() => void` | — | Expand callback |
| `onCollapse` | `() => void` | — | Collapse callback |
| `children` | `ReactNode` | — | Child TreeNodes (presence makes it a branch) |
| `theme` | `TreeTheme` | — | Per-instance theme override |

Nodes without children are rendered as leaves (indented, no expand button).

## Basic Usage

```tsx
<Tree>
  <TreeNode label="Root" expanded>
    <TreeNode label="Child 1">
      <TreeNode label="Grandchild 1" />
      <TreeNode label="Grandchild 2" />
    </TreeNode>
    <TreeNode label="Child 2" />
  </TreeNode>
</Tree>
```

## Controlled

```tsx
<Tree>
  <TreeNode
    label="Folder"
    expanded={isExpanded}
    onExpand={() => setExpanded(true)}
    onCollapse={() => setExpanded(false)}
  >
    <TreeNode label="File 1" />
    <TreeNode label="File 2" />
  </TreeNode>
</Tree>
```

## Custom Icons

```tsx
<Tree expandedIcon={<MinusIcon />} collapsedIcon={<PlusIcon />}>
  <TreeNode label="Node" expanded>
    <TreeNode label="Leaf" />
  </TreeNode>
</Tree>
```

## TreeTheme Interface

```typescript
interface TreeTheme {
  base: string;       // List (relative, list-none)
  tree: string;       // Outer container (border, padding)
  arrow: string;      // Default arrow icon sizing
  node: {
    base: string;     // Node item (pt, list-none)
    collapsed: string; // Collapsed icon rotation (-rotate-90)
    disabled: string;  // Disabled opacity
    leaf: string;      // Leaf indentation (pl)
    label: string;     // Label styles
    button: {
      base: string;   // Expand button (transition, margin)
      icon: string;   // Button icon sizing
    };
  };
  nodeBlock: string;  // Node row (flex, items-center)
  subtree: string;    // Nested list (ml, mt)
}
```
