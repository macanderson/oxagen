# Oxagen loading spinner (cursor type)

The mark types itself: a terminal cursor blinks in an empty slot, the "o" is
typed, the cursor advances to its place beside it and blinks the way a terminal
prompt does. This is the same mechanic as the brand's own spinner in
`docs/brand/spinner/` — that one types the whole `oxagen.sh` wordmark; this is
the single-glyph version of it, sized for a square slot.

## Files
- `oxagen-spinner-assemble.svg` — the brand's adaptive spinner, self-contained
  SMIL. Flips with `prefers-color-scheme`. Works as `<img src>`, CSS
  `background-image`, or inline.
- `oxagen-spinner-assemble-light/dark.gif` — raster fallback (128px, 16 frames,
  a 1.6s loop) for surfaces that strip SVG animation. `PwaSplash` uses these.

The two GIFs are rendered on the **solid splash background** they sit on
(`#0B0B0C` dark, `#FAFAFA` light) rather than on transparency — the splash
background is a known colour, and a matte avoids the fringing that 1-bit GIF
alpha produces around the round counter of the "o".

Colours are the brand's: ink `#F5F6F7` / `#0B0B0C`, cursor `#FF4B2A` / `#FF3D1F`.
The cursor is **not** the ember accent, and is not recoloured to match the UI —
see `packages/ui/THEME.md`.

## Regenerating

The GIFs are generated, not hand-drawn. Frames are emitted as SVG, rasterised
with `rsvg-convert`, and assembled with `ffmpeg` (`palettegen`/`paletteuse`, 64
colours). The frame table lives in the generator: four frames of a blinking
cursor in the empty slot, then the "o" plus the advanced cursor blinking two
frames on, two off.

Keep the mark's own path data and `viewBox` — copy them from
`docs/brand/logos/svg/oxagen-glyph-adaptive.svg` so the spinner and the logomark
cannot drift apart.

## Inline
```html
<span role="status" aria-label="Loading" style="display:inline-block;width:48px;height:48px">
  <!-- paste oxagen-spinner-assemble.svg -->
</span>
```

## React (svgr)
```tsx
import Mark from "@/assets/oxagen-spinner-assemble.svg?react";
export const OxLoader = ({ size = 48 }: { size?: number }) => (
  <span role="status" aria-label="Loading" style={{ display:"inline-block", width:size, height:size }}>
    <Mark width="100%" height="100%" />
  </span>
);
```

## Tuning
- Speed: the GIF is 10fps; change the generator's `-framerate`. For the SVG,
  change every `dur="3.6s"`.
- Blink rhythm: the frame table's trailing `[1, 74, …]` rows — two on, two off.
- The mark is **wider than it is tall**, so give it a square slot only when the
  slot is at least ~32px; below that prefer the cursor block alone.
