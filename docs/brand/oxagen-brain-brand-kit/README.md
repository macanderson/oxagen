# Oxagen — Ember Brand Kit

The editorial brain mark with the **ember gradient** (gold → flame → crimson),
paired with a **Space Grotesk** wordmark. The mark is the one from the supplied
brand assets, unchanged. The gradient is the canonical Oxagen ember and holds in
both light and dark modes — only the wordmark ink flips.

## Why Space Grotesk
A proportional grotesk with genuine character — the angular `a`, the open `g`,
a faintly mechanical rhythm. It reads deliberate and technical without collapsing
into the generic geometric-sans that floods AI-era branding, and its constructed
letterforms contrast the organic, hand-drawn synapses of the mark. Set at weight
~540 (medium). The wordmark is outlined to vector paths, so it renders identically
without the font installed.

## Color

### Ember gradient (the mark — never recolor)
| Stop | Hex | Role |
|------|-----|------|
| 0%   | `#F9D423` | gold |
| 50%  | `#FF7E5F` | flame |
| 100% | `#C2185B` | crimson |
Vector runs top-left → bottom-right.

### Grounds & ink
| Token | Hex | Use |
|-------|-----|-----|
| Ink (light) | `#16181D` | wordmark on light grounds |
| Ink (dark)  | `#F5F4F2` | wordmark on dark grounds |
| Navy        | `#0B0D16` | dark ground / icon tile |
| Paper       | `#FAF7F2` | warm light ground |

## Contents

```
svg/
  oxagen-mark.svg                       mark only (48x48), ember gradient
  oxagen-mark-mono.svg                  single flat flame tone (stamps/watermark)
  oxagen-lockup-horizontal.svg          mark + wordmark, adaptive ink (primary)
  oxagen-lockup-horizontal-gradient.svg wordmark in ember gradient (hero/marketing)
  oxagen-lockup-stacked.svg             mark above wordmark (tight/vertical spaces)

favicon/
  favicon.ico (16/32/48)  favicon.svg  favicon-16/32/48/192/512.png

pwa/
  icon-{72..512}.png        standard "any" icons (transparent)
  maskable-192/512.png      maskable, navy tile, 16% safe zone
  maskable-light-192/512.png
  apple-touch-icon.png      180x180, navy rounded tile
  manifest.json

social/
  og-image-light/dark-1200x630.png       Open Graph / Twitter card
  x-header-light/dark-1500x500.png        X profile header
  linkedin-banner-light/dark-1584x396.png

avatars/
  avatar-light/dark-400/512.png          rounded-square
  avatar-circle-light/dark-512.png        circle crop
  avatar-ember-512.png                    solid ember field, navy mark

backgrounds/
  loading-portrait-light/dark-1080x1920.png   app splash / loading screen
  loading-landscape-dark-1920x1080.png
  desktop-light/dark-2560x1440.png             wallpaper (QHD)
  desktop-dark-3840x2160.png                   wallpaper (4K)

spinner/
  oxagen-spinner-draw.svg                self-drawing brain (SMIL, signature loader)
  oxagen-spinner-draw-light/dark.gif     raster fallback
  USAGE.md

head-snippet.html   tokens.css   SpaceGrotesk.ttf   FONT-LICENSE.txt
```

## Graphic language
Loading and desktop backgrounds carry a faint **neural-network field** — ember
nodes and edges — echoing the synapses inside the mark. It speaks to what Oxagen
is: a knowledge graph holding and governing context for agents. Density is pushed
to edges so UI and content read clearly on top.

## Rules (from the supplied brand guidance)
- Don't recolor, rotate, or shadow the mark. Keep its ember gradient in both modes.
- Don't set the wordmark in another face.
- Clear space ≥ the mark's stem height around any lockup.
- Mark min size 24px; favicon use 32px+ for the synapse detail to read.
