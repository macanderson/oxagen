# Breadcrumbs

Navigation breadcrumb trail built with composable sub-components: Breadcrumbs, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator, and BreadcrumbPage.

## Import

```tsx
import {
  Breadcrumbs,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage
} from 'reablocks';
```

## Basic Usage

```tsx
<Breadcrumbs>
  <BreadcrumbList>
    <BreadcrumbItem>
      <BreadcrumbLink href="/">Home</BreadcrumbLink>
    </BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem>
      <BreadcrumbLink href="/products">Products</BreadcrumbLink>
    </BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem>
      <BreadcrumbPage>Current Page</BreadcrumbPage>
    </BreadcrumbItem>
  </BreadcrumbList>
</Breadcrumbs>
```

## Sub-components

- **Breadcrumbs** — `<nav>` wrapper with `aria-label="breadcrumbs"`
- **BreadcrumbList** — `<ol>` container with flex layout and gap
- **BreadcrumbItem** — `<li>` wrapper for each breadcrumb entry
- **BreadcrumbLink** — `<a>` link with hover transition styles
- **BreadcrumbSeparator** — Separator element (default: `/` character)
- **BreadcrumbPage** — Current page marker (styled as active, pointer-events-none)

## Breadcrumbs Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `theme` | `BreadcrumbsTheme` | — | Per-instance theme override |
| `className` | `string` | — | Additional CSS classes |

Also accepts all standard `<nav>` HTML attributes.

## BreadcrumbsTheme Interface

```typescript
interface BreadcrumbsTheme {
  base: string;        // Nav container
  separator: string;   // Separator icon sizing
  list: string;        // List container (flex, gap, items-center)
  link: string;        // Link styles (hover, transition)
  activePage: string;  // Active page (primary color, pointer-events-none)
}
```
