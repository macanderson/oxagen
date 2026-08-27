# Oxagen Theme — source of truth

The Oxagen design system is **token-driven**. Every visual property (color,
border, radius, elevation, state) resolves through a CSS custom property. No
component references a raw Tailwind palette color (`bg-blue-500`) or an arbitrary
hex. **Reskinning the entire app — light and dark — is done by editing one file:
`packages/ui/src/styles/globals.css`.**

The current skin is **Stella**, matching the palette shipped on
**stella.oxagen.sh**, so the app, the website and the Stella terminal read as
one surface. Every value below was read off that site's live stylesheet — its
`--st-*` primitive table — and its semantic layer is reproduced per theme:

| | light | dark |
|---|---|---|
| page | `#F7F4ED` *(st-paper-ground)* | `#0A0A0C` *(st-bg)* |
| card | `#FDFAF3` *(st-paper-raised)* | `#0F0F12` *(st-panel)* |
| popover | `#FFFCF5` *(st-paper)* | `#17171B` *(st-hl)* |
| hover / selected | `#E9E6E0` *(st-paper-row)* | `#26262C` *(st-border)* |
| hairline | `#E0DDD7` *(st-paper-seam)* | `#26262C` *(st-border)* |
| ink | `#0A0A0C` | `#F4F1EA` *(st-paper-text)* |
| secondary ink | `#605F5C` *(st-ink-muted)* | `#A9AAB5` *(st-silver)* |

Its defining move is that **the two modes sit on opposite hue axes**: the dark
canvas is cool (hue ~286, chroma 0.004–0.013) and the light paper is warm (hue
~87, chroma ~0.010). That is Stella's own choice, and it is what makes the one
accent read as *metal* against both rather than as a yellow.

**Card and table headers are flat** — they match their surface, separated only
by hairline borders. Colour lives in ONE **gold** (`--ox-ember`, `#EFC53F` —
`st-gold`): primary CTAs, focus rings, links, the active-tab underline, chart-1.
Gold is **identity and action only, never a state**.

Accent *copy* never uses `#EFC53F` directly — that is the mark colour and only
1.6:1 on paper. It uses `--ember-ink`, which resolves to the gold's own ink
shade in light (`#725A00` — `st-gold-ink`, 6.0:1) and to the gold itself in
dark (12.0:1). This is exactly what Stella's `--stella-accent-text` does, and
`--link` follows the same pair. **Links are gold, not indigo** — Stella ships
no indigo at all. The `--ox-indigo*` swatches survive only as `chart-2`, where
a fifth categorical hue is genuinely needed; they must never carry brand or
link meaning again.

> **Naming note.** The accent identifiers still read `ember`/`amber`
> (`--ox-ember`, `--_amber-*`, `--_ember-a/b/c`) from the previous skin. They
> hold Stella gold now. The names were kept rather than swept because ~25 files
> across `apps/docs` bind to them and a skin owns *values*, not identifiers.

The secondary is a quiet neutral fill and the hover/selected accent is neutral
too — Stella does not tint its rows with the accent. Colour is never smeared
across every surface (the system stays flat — no gradients/glows on chrome; see
§7). The topbar matches the page background. **The status ramp
(error / warning / success / info) is deliberately NOT part of this skin** and
was left on its previous values; gold being reserved from state means the two
ramps are free to differ. The wordmark is lowercase **`oxagen`** in **Aeonik**
at weight 660 / tracking -0.02em (`--font-wordmark`), the site's own `.brand`
setting. Surfaces use moderate rounding (`0.5rem`) and a subtle neutral shadow;
buttons do not grow on hover (`--button-hover-scale: 1`).

The brand mark gradient is the gold ramp — **`#725A00` → `#EFC53F` →
`#F7D96B`** (`--_ember-a/b/c`, at 0% / 46% / 100%) — theme-independent,
never recolored.

**The logomark is the "o + cursor" glyph** from `docs/brand/logos/svg/`. Its
"o" is ink and inherits `currentColor`; its cursor block keeps the brand's own
red-orange (`--ox-cursor`, `#FF3D1F` light / `#FF4B2A` dark). That cursor is
the one element deliberately NOT on the gold accent — it is kept faithful to
the canonical asset files rather than recoloured to match the UI around it.
The mark is **wider than it is tall** (143×90), so size it by height
(`h-7 w-auto`), never `size-*`.

---

## 1. Architecture — three layers + global controls

All three live in `packages/ui/src/styles/globals.css`.

| Layer | Where | What |
|---|---|---|
| **Value layer** | `:root` (light) + `.dark` (dark) + `@media (prefers-color-scheme: dark)` (system) | Raw `oklch()` values. **The only place a reskin touches.** |
| **Mapping layer** | the single `@theme inline { … }` block | Maps each `--<token>` → a Tailwind `--color-*` / `--radius-*` name, generating the semantic utilities. |
| **Component layer** | `packages/ui/src/components/*` + `apps/app/**` | References only generated semantic utilities (`bg-card`, `border-input-border-focus`, `text-tab-fg-active`). |

**Naming:** `--<area>-<element>-<part>-<state>` in the value layer
(`--input-border-focus`, `--menu-item-highlighted-bg`), mapped to a parallel
`--color-<same>` in `@theme` → utility `border-input-border-focus` /
`bg-menu-item-highlighted-bg`.

**The dark-mode trick:** component-level tokens are declared once on `:root` as
references to the **core** semantic tokens (e.g. `--input-bg: var(--background)`).
CSS resolves `var()` lazily in the element's cascade context, so when an element
inside `.dark` reads `--input-bg`, the underlying `--background` re-resolves to
its dark value. Therefore `.dark` only re-declares the ~30 **core** tokens; the
entire component-token surface inherits the theme flip for free.

---

## 2. How to reskin

Edit the **primitives** at the top of `:root` (and, if a hue needs a different
dark value, its `.dark` counterpart). Everything downstream follows. See the
worked example in §8.

### Global controls (single knobs)

| Token | Default | Effect |
|---|---|---|
| `--ui-radius` | `0.5rem` | Master corner radius. The whole `--radius-*` scale derives from it. Set `0px` for hard square corners. |
| `--ui-shadow` | `0 1px 2px oklch(0.15 0 0 / 0.07)` | Master elevation. Every Tailwind `shadow-*` step reads it. Set `0 0 #0000` for a flat UI. |

---

## 3. Primitives (raw oklch palette)

The only literal colors in the system. Swap these to reskin.

### Brand anchors

| Token | oklch | hex | Purpose |
|---|---|---|---|
| `--_paper` | `oklch(0.968 0.010 87.5)` | `#F7F4ED` | Light page — `st-paper-ground` |
| `--_ink` | `oklch(0.146 0.004 285.9)` | `#0A0A0C` | Light-mode ink AND dark page — `st-bg` |
| `--_ink-white` | `oklch(0.959 0.010 87.5)` | `#F4F1EA` | Dark-mode ink — `st-paper-text` |

### Neutral ramp (stone) — Stella's elevation ladder, 1:1

The dark steps are Stella's canvas values and the light steps its paper values,
so a single ramp carries both halves of the skin. Steps 400–700 are the
exception: they carry **text**, and use Stella's silver → dim ink ramp.

| Token | hex | Purpose |
|---|---|---|
| `--_stone-50` | `#FFFCF5` | Light popover — `st-paper` |
| `--_stone-100` | `#F9F6EF` | Muted / card-header — `st-paper-panel` |
| `--_stone-150` | `#F7F4ED` | Surface-alt (light) — `st-paper-ground` |
| `--_stone-200` | `#E9E6E0` | Secondary / hover (light) — `st-paper-row` |
| `--_stone-300` | `#E0DDD7` | Border / input (light) — `st-paper-seam` |
| `--_stone-400` | `#A9AAB5` | muted-foreground (dark) — `st-silver` |
| `--_stone-500` | `#777782` | Tertiary text — `st-muted` |
| `--_stone-600` | `#605F5C` | Secondary text (light) — `st-ink-muted` |
| `--_stone-700` | `#4B4B56` | Hints / line numbers — `st-dim` |
| `--_stone-800` | `#26262C` | Hairline / accent surface (dark) — `st-border` |
| `--_stone-850` | `#17171B` | Popover / muted (dark) — `st-hl` |
| `--_stone-900` | `#0F0F12` | Card / sidebar (dark) — `st-panel` |
| `--_stone-950` | `#0A0A0C` | Page background (dark) — `st-bg` |

### Gold accent ramp

The `--_amber-*` ramp drives the accent-subtle backgrounds. It is anchored at
`400` on `#EFC53F` so it matches `--ox-ember` exactly, and `300` / `600` are
Stella's own `st-gold-bright` / `st-gold-ink`, so it interpolates *through*
real brand stops rather than around them.

| Token | oklch | approx hex | Purpose |
|---|---|---|---|
| `--_amber-50` | `oklch(0.985 0.020 90)` | `#FFFAEB` | Accent subtle (light) |
| `--_amber-100` | `oklch(0.962 0.042 90)` | `#FDF2D3` | — |
| `--_amber-200` | `oklch(0.925 0.085 90.5)` | `#FCE5A5` | — |
| `--_amber-300` | `oklch(0.8893 0.1332 94.3)` | `#F7D96B` | `st-gold-bright` |
| `--_amber-400` | `oklch(0.839 0.152 90.8)` | `#EFC53F` | **Gold** — primary accent (`st-gold`) |
| `--_amber-500` | `oklch(0.700 0.130 90.7)` | `#BD9A2A` | — |
| `--_amber-600` | `oklch(0.478 0.098 90.6)` | `#725A00` | `st-gold-ink` — accent TEXT on paper |
| `--_amber-700` | `oklch(0.400 0.082 90)` | `#594500` | Link hover (light) |
| `--_amber-800` | `oklch(0.310 0.062 89)` | `#3D2E01` | — |
| `--_amber-900` | `oklch(0.235 0.045 88)` | `#271D02` | — |

### Brand mark (the gold ramp)

| Token | hex | Note |
|---|---|---|
| `--_ember-a` | `#725A00` | Gradient start — `st-gold-ink` |
| `--_ember-b` | `#EFC53F` | Gradient midpoint (46%) — the solid mark colour |
| `--_ember-c` | `#F7D96B` | Gradient end — `st-gold-bright` |
| `--_ember-navy` | `#0A0A0C` | Ink anchor — `st-bg` |

Named brand swatches: `--ox-ember-deep` / `--ox-ember` / `--ox-ember-light`
carry the three stops; `--ox-ember` (#EFC53F) is the master accent knob.
`--ox-cursor` (#FF3D1F light / #FF4B2A dark) is the logomark's cursor block —
the one swatch that is intentionally off the gold accent, kept faithful to the
canonical files in `docs/brand/logos/`.

`--ox-indigo` (#4C51A8 light / #9CA3E8 dark) is **chart-2 only**. Stella ships
no indigo; this swatch exists because a five-series categorical ramp needs a
hue that is not gold, green, red or orange.

The old coral swatches (`--ox-tangerine`, `--ox-rose`, `--ox-teak`,
`--ox-bronze`, `--ox-sunset-red`, `--ox-gold`, `--ox-wheat`, `--_terracotta*`)
were **removed**, not re-pointed: they named an earlier brand, had no
consumers outside the token file, and a swatch called "rose" holding amber is a
comment that lies.

### Status hues

| Token | hex | Meaning |
|---|---|---|
| `--_moss` / `--_moss-light` | `#1D9E75` adj. | Success |
| `--_ochre` / `--_ochre-light` | `#BA7517` adj. | Warning |
| `--_clay` / `--_clay-light` | `#E23B3B` adj. | Error — **true red** (`hsl 0 72%`) in both modes |
| `--_slate` / `--_slate-light` | `#4E6A7A` adj. | Info |

---

## 4. Core semantic tokens (light / dark)

These ~30 tokens (mapped to `--color-*` → utilities `bg-background`,
`text-foreground`, `border-border`, …) are the reskin surface.

| Token | Light | Dark |
|---|---|---|
| `--background` | `--_paper` (#F7F4ED) | `--_stone-950` (#0A0A0C) |
| `--foreground` | `--_ink` (#0A0A0C) | `--_ink-white` (#F4F1EA) |
| `--card` / `--popover` | #FDFAF3 / #FFFCF5 | stone-900 (#0F0F12) / stone-850 (#17171B) |
| `--primary` | **gold** (#EFC53F) | **gold** (#EFC53F) |
| `--primary-foreground` | ink (#0A0A0C — white fails AA on gold) | ink (#0A0A0C) |
| `--secondary` | stone-200 (#E9E6E0) | stone-800 (#26262C) |
| `--secondary-foreground` | ink | ink-white |
| `--muted` / `--muted-foreground` | stone-100 (#F9F6EF) / stone-600 (#605F5C) | stone-850 (#17171B) / stone-400 (#A9AAB5) |
| `--accent` / `--accent-foreground` | stone-200 (neutral row wash) / ink | stone-800 (neutral) / ink-white |
| `--border` | stone-300 (#E0DDD7) | stone-800 (#26262C) |
| `--input` | stone-300 (#E0DDD7) | st-rule (#2C2C33) |
| `--link` / `--ember-ink` | #725A00 (st-gold-ink, 6.0:1) | #EFC53F (gold, 12.0:1) |
| `--ring` | **gold** | **gold** |
| `--link` | indigo #4C51A8 (6.9:1) | indigo #9CA3E8 (8.3:1) |
| `--success/-foreground` | moss / white | moss-light / dark |
| `--warning/-foreground` | ochre / dark | ochre-light / dark |
| `--error/-foreground` | true red / white | true red / white |
| `--info/-foreground` | slate / white | slate-light / dark |
| `--chart-1 … 5` | ember · indigo · moss · orange · slate | bright equivalents |
| `--sidebar*` | white, ember accent | stone-900, ember accent |

---

## 5. Component tokens

Unchanged from the architecture — declared once on `:root`, referencing core
tokens (so they flip automatically). Each is mapped to a `--color-*` utility.

**Sidebar:** `--sidebar-bg/-fg`, `--sidebar-nav-label-fg`,
`--sidebar-nav-link-fg`, `--sidebar-nav-link-hover-bg/-fg`,
`--sidebar-nav-link-active-bg/-fg`, `--sidebar-border-width` (`1px`),
`--sidebar-width` (`16rem`), `--sidebar-icon-width` (`3.5rem`).

**App chrome:** `--app-panel-bg/-fg`, `--app-topbar-bg/-fg/-border`,
`--app-link-fg`, `--app-link-hover-fg`, `--app-link-active-fg`.

**Tabs:** `--tab-fg` / `-hover` / `-active`, `--tab-border` / `-hover` /
`-active`, `--tab-border-width` (`2px`).

**Buttons** (`primary` + `default`): `--button-primary-bg/-fg/-border/-hover-bg/
-active-bg/-ring` and `--button-default-bg/-fg/-border/-hover-bg/-active-bg/
-ring`, plus `--button-disabled-bg/-fg`.

**Inputs / textareas:** `--input-bg`, `--input-fg`, `--input-placeholder`,
`--input-border`, `--input-border-hover`, `--input-border-focus`, `--input-ring`,
`--input-disabled-bg/-fg`, `--input-invalid-border/-ring`.

**Select / Menu:** `--menu-popup-bg/-fg/-border`, `--menu-item-fg`,
`--menu-item-highlighted-bg/-fg`, `--menu-item-disabled-fg`,
`--menu-item-selected-bg/-fg`, `--menu-separator`, `--menu-group-label-fg`.

**Checkbox / Radio / Switch:** `--control-track-bg`,
`--control-track-bg-checked`, `--control-indicator`, `--control-thumb`,
`--control-border`, `--control-ring`.

**Tooltip / Dialog / Badge / Overlay:** `--tooltip-bg/-fg/-border`,
`--dialog-bg/-fg/-border`, `--overlay-scrim`, `--badge-bg/-fg/-border`.

---

## 6. Base UI state-wiring rules

The components use **Base UI** (`@base-ui/react`), not Radix. State is styled via
Base UI data-attributes:

| Primitive | Attribute | Token utility |
|---|---|---|
| Tabs | `data-[selected]` | `border-tab-border-active`, `text-tab-fg-active` |
| Menu / Select item | `data-[highlighted]` | `bg-menu-item-highlighted-bg` |
| Select item | `data-[selected]` | `bg-menu-item-selected-bg` |
| Select trigger / submenu | `data-[popup-open]` | open-state styling |
| Checkbox / Switch / Radio | `data-[checked]` | `bg-control-track-bg-checked` |
| Field / input | `data-[invalid]` + `aria-[invalid=true]` | `border-input-invalid-border` |
| Any | `data-[disabled]` | disabled treatment |

---

## 7. Motion policy — **motion is retained**

Tune feel via `--motion-*` / `--ease-*` tokens. The Ember skin keeps
structural motion: tab slide, overlay enter/exit, control transitions,
`.hover-lift`, `.hover-glow` (accent ring via `--ring`), `.animate-in`, wand
pulse. Button hover-grow is neutralized (`--button-hover-scale: 1`) — hover
feedback is the color-mix background shift. The skin stays **flat** — no
gradients, glows, mesh, or glassmorphism on chrome (depth is a 1px border); the
ember gradient is reserved for the brand mark and marketing surfaces
only.

Global `prefers-reduced-motion` kill-switch zeroes animation/transition durations.

---

## 8. Worked reskin example — swap the ember accent hue

Goal: change the ember accent to a teal, light + dark, in one edit.
`--ox-ember` drives `--primary`, `--ring`, sidebar accent, the active-tab
underline and chart-1, so repointing that anchor re-skins them all.

### Before

```css
/* packages/ui/src/styles/globals.css — :root, PRIMITIVES block */
--ox-ember: oklch(0.839 0.152 90.8);   /* #EFC53F — gold */
--_amber-400: oklch(0.839 0.152 90.8);   /* gold (accent-subtle anchor) */
```

### After

```css
--ox-ember: oklch(0.72 0.14 185);   /* teal */
--_amber-400: oklch(0.72 0.14 185);   /* teal */
```

(Also retune `--link`/`--link-hover` in all three theme blocks — they are
hand-picked text-safe shades of the accent hue.)

That's it. `--brand`, `--primary`, `--ring`, `--accent`, sidebar accent, button
backgrounds, focus rings, chart-1 — all re-point to the new hue in both themes
because they resolve through `--_amber-500` / `--_amber-300`. No component file
changes.

To flatten corners or remove shadows, edit the two control knobs (§2):
`--ui-radius: 0px;` and `--ui-shadow: 0 0 #0000;`.

---

## 9. Documented exceptions

- **`.ox-grid-dots`** — a token-driven dotted texture (functional grid, kept).
- **`.tabs-edge-fade`** — a `linear-gradient` *mask* (structural, kept).
- **`global-error.tsx`** — top-level crash page uses hardcoded hexes (no theme
  context available).
- **`field-fill-transition.tsx` / wand button** — self-contained keyframes
  (motion-only, flat).
- **Brand mark** — the `--brand-gradient` and `--_ember-*` tokens are
  theme-independent (identical light/dark): the #725A00 → #EFC53F → #F7D96B sweep.
  Recolor them only as a deliberate brand change, in lockstep with the named
  `--ox-ember-deep` / `--ox-ember-light` swatches — never per-theme.
  Only the ink (wordmark strokes) flips via `--_ink` / `--_ink-white`.
- **`global-error.tsx`** — its hardcoded crash-page hexes are NOT theme-aware; if
  the brand hues change, update them there too (no `@oxagen/ui` tokens are loaded
  on the top-level crash boundary).
