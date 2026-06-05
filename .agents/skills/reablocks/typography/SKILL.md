# Typography

Themed text components for headings, paragraphs, and semantic text styles. All share a single `TypographyTheme` and follow the same pattern: thin `forwardRef` wrappers that render a semantic HTML element with themed classes merged via `cn()`.

## Import

```tsx
import { H1, H2, H3, H4, H5, H6, P, BlockQuote, Lead, Large, Small, Muted } from 'reablocks';
```

## Components

All accept `className`, `theme`, `children`, `ref`, and their respective HTML element attributes.

| Component | HTML Element | Default Styles |
|-----------|-------------|----------------|
| `H1` | `<h1>` | `text-4xl font-extrabold tracking-tight text-balance` |
| `H2` | `<h2>` | `text-3xl font-semibold tracking-tight border-b border-surface pb-2` |
| `H3` | `<h3>` | `text-2xl font-semibold tracking-tight` |
| `H4` | `<h4>` | `text-xl font-semibold tracking-tight` |
| `H5` | `<h5>` | `text-lg font-semibold tracking-tight` |
| `H6` | `<h6>` | `text-base font-semibold tracking-tight` |
| `P` | `<p>` | `leading-7 [&:not(:first-child)]:mt-6` |
| `BlockQuote` | `<blockquote>` | `mt-6 border-l-2 border-surface pl-6 italic` |
| `Lead` | `<p>` | `text-xl text-text-secondary` |
| `Large` | `<div>` | `text-lg font-semibold` |
| `Small` | `<small>` | `text-sm leading-none font-medium` |
| `Muted` | `<p>` | `text-sm text-text-secondary` |

All headings (H1–H6) include `scroll-m-20` for scroll-margin compatibility with anchor links.

## Common Props

Every typography component accepts:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `className` | `string` | — | Additional CSS classes (merged last) |
| `theme` | `TypographyTheme` | — | Per-instance theme override |
| `children` | `ReactNode` | — | Text content |
| `ref` | `Ref` | — | Forward ref to the HTML element |

Plus all attributes of the underlying HTML element.

## Basic Usage

```tsx
<H1>Page Title</H1>
<H2>Section Heading</H2>
<P>Body paragraph text with automatic top margin on non-first children.</P>
<BlockQuote>A notable quote with left border and italic styling.</BlockQuote>
<Lead>Intro text in larger, secondary-colored style.</Lead>
<Large>Emphasized larger text.</Large>
<Small>Fine print or label text.</Small>
<Muted>Subdued helper text.</Muted>
```

## Full Page Example

```tsx
<div className="max-w-2xl">
  <H1>The Page Title</H1>
  <Lead>A brief introduction paragraph in larger, muted style.</Lead>
  <H2>Section Heading</H2>
  <P>Regular paragraph content with leading-7 line height.</P>
  <BlockQuote>A quoted passage with left border.</BlockQuote>
  <H3>Subsection</H3>
  <P>More content here.</P>
  <Large>Important callout text</Large>
  <Small>Fine print label</Small>
  <Muted>Helper text in muted style</Muted>
</div>
```

## TypographyTheme Interface

All components share this single theme object (keyed as `'typography'` in the theme):

```typescript
interface TypographyTheme {
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  h5: string;
  h6: string;
  p: string;
  blockquote: string;
  lead: string;
  large: string;
  small: string;
  muted: string;
}
```

Default and unify themes are identical for typography.
