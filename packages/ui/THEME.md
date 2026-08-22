# Oxagen Theme — source of truth

The Oxagen design system is **token-driven**. Every visual property (color,
border, radius, elevation, state) resolves through a CSS custom property. No
component references a raw Tailwind palette color (`bg-blue-500`) or an arbitrary
hex. **Reskinning the entire app — light and dark — is done by editing one file:
`packages/ui/src/styles/globals.css`.**

The current skin is **Oxagen Ember**, matching the brand shipped on
**oxagen.sh**. Its defining move is a split: **surfaces are neutral, ink is
warm.** In dark the surface steps are the site's own — `#0B0B0C` page →
`#141414` card → `#161616` popover → `#2A2A2A` accent, every one at chroma
`0.000` — while the text ramp above them stays warm (`#F1EDEA` → `#BCB2A9` →
`#6E6A5F`). That is what makes the product read as black-and-gold rather than
as grey, and it is the difference from the old skin, which tinted every panel
warm. Light mode is neutral paper with crisp white panels.

**Card and table headers are flat** — they match their surface, separated only
by hairline borders. Colour lives in ONE **ember primary** (`--ox-ember`,
`#FFB000`) — primary CTAs, focus rings, the active-tab underline, chart-1.
**Links are indigo, not ember** (`--ox-indigo*`), exactly as the site sets
them: `#9CA3E8` in dark, darkened to `#4C51A8` in light where the site value
would only reach 2.4:1. Accent *copy* never uses `#FFB000` directly — that is
the mark colour and is 1.8:1 on paper — it uses `--ember-ink`, which resolves
to a deep ember in light (5.5:1) and the site's `#FFCB66` in dark (13.1:1).

The secondary is a quiet neutral fill, the hover/selected accent a
barely-there ember tint. Colour is never smeared across every surface (the
system stays flat — no gradients/glows on chrome; see §7). The topbar matches
the page background. Errors use a true **red**, and **warning is pushed to
orange** (hue ~52) because the ember primary now sits at hue ~76 where the old
ochre warning used to live — at a terracotta primary (hue 40) they were far
apart, and they no longer are. The wordmark is lowercase **`oxagen`** in
**Aeonik** at weight 660 / tracking -0.02em (`--font-wordmark`), the site's own
`.brand` setting. Surfaces use moderate rounding (`0.5rem`) and a subtle
neutral shadow; buttons do not grow on hover (`--button-hover-scale: 1`).

The brand mark gradient is the site's ember ramp — **`#A37200` → `#FFB000`
→ `#FFCB66`** (`--_ember-a/b/c`, at 0% / 46% / 100%) — theme-independent,
never recolored.

**The logomark is the "o + cursor" glyph** from `docs/brand/logos/svg/`. Its
"o" is ink and inherits `currentColor`; its cursor block keeps the brand's own
red-orange (`--ox-cursor`, `#FF3D1F` light / `#FF4B2A` dark). That cursor is
the one element deliberately NOT on the ember accent — it is kept faithful to
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
| `--_paper` | `oklch(0.985 0 0)` | `#FAFAFA` | Light mode background (neutral paper) |
| `--_ink` | `oklch(0.150 0.002 286)` | `#0B0B0C` | Primary text + wordmark ink — the site's page black |
| `--_ink-white` | `oklch(0.948 0.006 60)` | `#F1EDEA` | Primary text + wordmark ink (dark) — the site's `--ink` |

### Neutral ramp (stone) — neutral surfaces, WARM text steps

The dark steps are oxagen.sh's own surface values and are genuinely neutral
(chroma `0.000`). Steps 400/500/600 are the exception: they carry **text**, and
the site's ink ramp is warm, so they keep their chroma.

| Token | approx hex | Purpose |
|---|---|---|
| `--_stone-50` | `#FCFCFC` | Near-white |
| `--_stone-100` | `#F3F3F3` | Muted background / card-header |
| `--_stone-150` | `#EEEEEE` | Surface-alt (light) |
| `--_stone-200` | `#E6E6E6` | Secondary surfaces |
| `--_stone-300` | `#D9D9D9` | Input borders (light) |
| `--_stone-400` | `#BCB2A9` | muted-foreground (dark) — site `--muted` *(warm)* |
| `--_stone-500` | `#6E6A5F` | Tertiary text — site `--faint` *(warm)* |
| `--_stone-600` | `#5F5A52` | Secondary text (light) *(warm)* |
| `--_stone-700` | `#3E3A34` | Graphite *(warm)* |
| `--_stone-800` | `#2A2A2A` | Accent surface (dark) — site `--line` |
| `--_stone-850` | `#161616` | Popover / muted (dark) — site `--card` |
| `--_stone-900` | `#141414` | Card / sidebar (dark) — site `--surface` |
| `--_stone-950` | `#0B0B0C` | Page background (dark) — site `--bg` |

### Ember accent ramp

The `--_amber-*` ramp drives the accent-subtle backgrounds. It is anchored at
`400` on `#FFB000` so it matches `--ox-ember` exactly, and shades down through
the site's deep ember at `600`.

| Token | oklch | approx hex | Purpose |
|---|---|---|---|
| `--_amber-50` | `oklch(0.975 0.022 85)` | `#FEF6E7` | Accent subtle (light) |
| `--_amber-100` | `oklch(0.950 0.045 84)` | `#FDEDCD` | — |
| `--_amber-200` | `oklch(0.910 0.085 82)` | `#FEDDA0` | — |
| `--_amber-300` | `oklch(0.869 0.132 82.1)` | `#FFCB66` | Site `--ember-c` |
| `--_amber-400` | `oklch(0.812 0.170 76.4)` | `#FFB000` | **Ember** — primary accent |
| `--_amber-500` | `oklch(0.720 0.150 77.5)` | `#D89602` | — |
| `--_amber-600` | `oklch(0.587 0.122 78.7)` | `#A37200` | Site `--ember-a` |
| `--_amber-700` | `oklch(0.480 0.100 79)` | `#7B5600` | — |
| `--_amber-800` | `oklch(0.370 0.075 72)` | `#583806` | — |
| `--_amber-900` | `oklch(0.280 0.055 65)` | `#3B2207` | — |

### Brand mark (the site's ember ramp)

| Token | hex | Note |
|---|---|---|
| `--_ember-a` | `#A37200` | Gradient start — site `--ember-a` |
| `--_ember-b` | `#FFB000` | Gradient midpoint (46%) — the solid mark colour |
| `--_ember-c` | `#FFCB66` | Gradient end — site `--ember-c` |
| `--_ember-navy` | `#0B0B0C` | Ink anchor — the site's page black |

Named brand swatches: `--ox-ember-deep` / `--ox-ember` / `--ox-ember-light`
carry the three stops; `--ox-ember` (#FFB000) is the master accent knob.
`--ox-cursor` (#FF3D1F light / #FF4B2A dark) is the logomark's cursor block —
the one swatch that is intentionally off the ember accent.

The old coral swatches (`--ox-tangerine`, `--ox-rose`, `--ox-teak`,
`--ox-bronze`, `--ox-sunset-red`, `--ox-gold`, `--ox-wheat`, `--_terracotta*`)
were **removed**, not re-pointed: they named the previous brand, had no
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
| `--background` | `--_paper` (#FAF9F5) | `--_stone-950` (#1E1D1B) |
| `--foreground` | `--_ink` (#1F1E1D) | `--_ink-white` (#F1EEEA) |
| `--card` / `--popover` | white / white | stone-900 / stone-850 |
| `--primary` | **ember** (#FFB000) | **ember** (#FFB000) |
| `--primary-foreground` | ink (#0B0B0C — white fails AA on ember) | ink (#0B0B0C) |
| `--secondary` | quiet warm-neutral fill | warm-clay chip fill |
| `--secondary-foreground` | deep warm gray | ink-white |
| `--muted` / `--muted-foreground` | stone-100 / stone-600 | stone-850 / stone-400 |
| `--accent` / `--accent-foreground` | ember tint / deep ember ink | ember-soft tint / ink-white |
| `--border` | warm hairline | warm charcoal hairline |
| `--input` | stone-300 | warm charcoal |
| `--ring` | **ember** | **ember** |
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
--ox-ember: oklch(0.812 0.170 76.4);   /* #FFB000 — ember */
--_amber-400: oklch(0.812 0.170 76.4);   /* ember (accent-subtle anchor) */
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
  theme-independent (identical light/dark): the #A37200 → #FFB000 → #FFCB66 sweep.
  Recolor them only as a deliberate brand change, in lockstep with the named
  `--ox-ember-deep` / `--ox-ember-light` swatches — never per-theme.
  Only the ink (wordmark strokes) flips via `--_ink` / `--_ink-white`.
- **`global-error.tsx`** — its hardcoded crash-page hexes are NOT theme-aware; if
  the brand hues change, update them there too (no `@oxagen/ui` tokens are loaded
  on the top-level crash boundary).
