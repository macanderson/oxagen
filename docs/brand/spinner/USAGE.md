# Oxagen loading spinner (hex assembly)

The six hexagons of the mark assemble one by one into the honeycomb, hold the
complete mark, then dissolve and rebuild. A 2.8s loop. Thematically tied to the
hexagon logo the way a self-drawing brain would tie to a brain mark.

## Files
- `oxagen-spinner-assemble.svg` — light-ink, self-contained SMIL. Works as
  `<img src>`, CSS `background-image`, or inline.
- `oxagen-spinner-assemble-dark.svg` — light ink for dark grounds.
- `oxagen-spinner-assemble-light/dark.gif` — raster fallback (128px) for
  surfaces that strip SVG animation.

The ember gradient on the two filled hexagons is fixed — never recolor it.

## Inline
```html
<span role="status" aria-label="Loading" style="display:inline-block;width:48px;height:48px">
  <!-- paste oxagen-spinner-assemble.svg (or -dark for dark UI) -->
</span>
```

## React (svgr)
```tsx
import Hex from "@/assets/oxagen-spinner-assemble.svg?react";
export const OxLoader = ({ size = 48 }: { size?: number }) => (
  <span role="status" aria-label="Loading" style={{ display:"inline-block", width:size, height:size }}>
    <Hex width="100%" height="100%" />
  </span>
);
```

## Tuning
- Speed: change every `dur="2.8s"`.
- Stagger: the per-hex `begin` offsets (0, .13, .26, .39, .52, .65s) set the
  build order — top row first, down to the bottom.
- Below ~32px the six cells crowd; for tiny spinners prefer a single-hex pulse.
