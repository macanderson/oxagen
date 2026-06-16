# Oxagen loading spinners (Ember)

Two animated variants, both built from the real brain mark with the ember gradient.

## Self-drawing brain — `oxagen-spinner-draw.svg`
The signature loader. Over a 2.6s loop: the central stem and two hemisphere
outlines stroke on top-to-bottom, the four synapse edges draw in, then the
nodes pop and pulse — the brain "lighting up" with thought — before looping.
A faint ghost outline underneath keeps the silhouette readable throughout.

- Self-contained SMIL — works as `<img src>`, CSS `background-image`, or inline.
- Respects `prefers-reduced-motion` when used inline via the CSS-keyframe build
  (slows rather than stops).
- `oxagen-spinner-draw-light/dark.gif` — raster fallback (128px, 48 frames)
  for surfaces that strip SVG animation (some email clients, older webviews).

## Inline (recommended)
```html
<span role="status" aria-label="Loading"
      style="display:inline-block;width:48px;height:48px">
  <!-- paste oxagen-spinner-draw.svg contents -->
</span>
```

## As <img>
```html
<img src="/spinner/oxagen-spinner-draw.svg" width="48" height="48" alt="Loading">
```

## React (svgr)
```tsx
import Brain from "@/assets/oxagen-spinner-draw.svg?react";
export const OxLoader = ({ size = 48 }: { size?: number }) => (
  <span role="status" aria-label="Loading"
        style={{ display:"inline-block", width:size, height:size }}>
    <Brain width="100%" height="100%" />
  </span>
);
```

## Tuning
- Speed: change every `dur="2.6s"` (SMIL) or `animation-duration` (CSS).
- The mark gradient is fixed (`#F9D423 → #FF7E5F → #C2185B`). Don't recolor it.
- Below ~28px the synapse detail blurs; for tiny inline spinners prefer a simple
  fade-pulse of the whole mark over the self-drawing sequence.
