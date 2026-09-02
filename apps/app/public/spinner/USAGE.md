# Oxagen loading spinners

Two different spinners live here. They share one idea — a terminal cursor
blinks, letters get typed next to it, the cursor moves along — but they are not
the same artwork, and they are not interchangeable.

## Files

### `oxagen-spinner-assemble.svg` — the full wordmark

A byte-for-byte copy of `docs/brand/spinner/oxagen-spinner-adaptive.svg`. It
types the whole `oxagen.sh` wordmark. Self-contained SMIL animation, and it
flips light/dark on its own through `prefers-color-scheme`. Works as an
`<img src>`, a CSS `background-image`, or inline.

**It is very wide: 690 × 111, about 6.2 : 1.** Give it a wide slot. Put it in a
square box and it shrinks to the width of the box, which leaves the letters
about a sixth as tall as the box — too small to read.

`RouteTransitionLoader`
(`apps/app/src/components/pwa/route-transition-loader.tsx`) currently renders
it in a 72 × 72 box, which is too small for it.

### `oxagen-spinner-assemble-*.gif` — the single-glyph version

`oxagen-spinner-assemble-light.gif` and `oxagen-spinner-assemble-dark.gif` are
the one-letter version: a cursor blinks in an empty slot, the "o" is typed, the
cursor moves beside it and keeps blinking. 128 px square, 16 frames, a 1.6 s
loop. `PwaSplash` uses these.

The GIFs are **not transparent**. Each frame is painted on a solid background,
because 1-bit GIF transparency leaves an ugly fringe around the round hole in
the "o". A solid background is cleaner and smaller.

> **Known drift — the background colours no longer match.** The GIFs were baked
> onto `#0B0B0C` (dark) and `#FAFAFA` (light). The Stella reskin (#1430) moved
> the splash to `#0A0A0C` (dark) and `#F7F4ED` (light) — see
> `apps/app/src/components/pwa/pwa-splash.module.css`. So the GIF now sits on
> the splash as a faintly visible 128 px square. Fixing it means updating the
> `dark`/`light` `bg` values in `tools/scripts/gen-spinner-gifs.mjs` and
> re-running the generator.

Ink is `#F5F6F7` on dark and `#0B0B0C` on light. The cursor is `#FF4B2A` on
dark and `#FF3D1F` on light. The cursor colour is **not** the ember accent, and
it is never recoloured to match the surrounding UI — see `packages/ui/THEME.md`.

## Regenerating the GIFs

The GIFs are generated, not drawn by hand. `tools/scripts/gen-spinner-gifs.mjs`
emits each frame as SVG, rasterises it with `rsvg-convert`, and stitches the
frames with `ffmpeg` (`palettegen` / `paletteuse`, 64 colours). The frame table
lives in that script: four frames of a blinking cursor in an empty slot, then
the "o" plus the moved cursor, blinking two frames on and two off.

Keep the letterform's path data and `viewBox` in sync with
`docs/brand/logos/svg/oxagen-glyph-adaptive.svg`, so the spinner and the
logomark can never drift apart.

## Using the SVG inline

```html
<span role="status" aria-label="Loading" style="display:inline-block;width:240px">
  <!-- paste oxagen-spinner-assemble.svg -->
</span>
```

## Using the SVG in React (svgr)

```tsx
import Mark from "@/assets/oxagen-spinner-assemble.svg?react";

export const OxLoader = ({ width = 240 }: { width?: number }) => (
  <span role="status" aria-label="Loading" style={{ display: "inline-block", width }}>
    <Mark width="100%" height="100%" />
  </span>
);
```

## Tuning

- **Speed.** The GIFs run at 10 fps — change `-framerate` in the generator. For
  the SVG, change every `dur="3.6s"`.
- **Blink rhythm.** Edit the trailing rows of the generator's frame table
  (`[1, 74, …]`) — two frames on, two frames off.
