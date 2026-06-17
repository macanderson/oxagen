# Oxagen — Nocturne Violet Brand Kit

The official Oxagen hexagon-cluster mark and "oxagen" wordmark, taken from the
supplied master logo and left unchanged. The mark keeps its **ember gradient**
(gold → flame → crimson) in both light and dark modes; only the ink (the
stroked hexagons and the wordmark) flips between modes.

This kit introduces a new **Nocturne Violet** color theme for the UI tokens —
a deep, cool violet/indigo system chosen to complement the warm ember mark.
Warm logo, cool ground. See `tokens.css`.

## Color

### Ember mark (fixed — never recolor)
| Stop | Hex |
|------|-----|
| 0%   | `#F9D423` gold |
| 50%  | `#FF7E5F` flame |
| 100% | `#C2185B` crimson |

### Nocturne Violet theme (new)
| Token | Light | Dark |
|-------|-------|------|
| Background | `#FAF7F2` | `#0B0D16` |
| Surface | `#FFFFFF` | `#15131F` |
| Primary accent | `#6E48CE` | `#A78BFA` |
| Ink / text | `#16181D` | `#F5F4F2` |

The violet accent (`--ox-violet-*`) drives links, focus rings, and selected
states. It sits opposite ember on the wheel, so the warm mark always reads as
the focal point against cool surfaces.

## Contents

```
svg/
  oxagen-mark.svg                       hexagon mark, adaptive ink + ember fills
  oxagen-mark-mono.svg                  single flat flame tone
  oxagen-lockup-horizontal.svg          full logo, adaptive ink (primary)
  oxagen-lockup-horizontal-gradient.svg wordmark in ember gradient (hero)
  oxagen-lockup-stacked.svg             mark above wordmark

favicon/   favicon.ico (16/32/48), favicon.svg, favicon-16/32/48/192/512.png
pwa/       icon-{72..512}.png, maskable + maskable-light 192/512,
           apple-touch-icon.png (navy tile), manifest.json
social/    og-image, x-header, linkedin-banner — each light + dark
avatars/   light/dark 400+512, circle light/dark, ember field
backgrounds/ loading portrait+landscape, desktop 2560 + 4K (light/dark)
spinner/   oxagen-spinner-assemble.svg (+ -dark), GIF fallbacks, USAGE.md

head-snippet.html   tokens.css
```

## Graphic language
Loading and desktop backgrounds use a faint **hexagon tessellation** — a
honeycomb of thin violet-warm cells with occasional ember-filled hexes glowing
like active nodes. It extends the mark's geometry and reads as a structured
lattice of context. Kept subtle so UI and content sit cleanly on top.

## Rules
- Don't recolor, rotate, or shadow the mark. Ember stays ember in both modes.
- Only the ink (hexagon strokes + wordmark) flips light/dark.
- Mark min size 24px; favicon use 32px+ for the hex detail to read.
- Clear space ≥ one hexagon width around any lockup.
