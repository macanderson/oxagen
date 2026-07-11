# Oxagen Theme — source of truth

The Oxagen design system is **token-driven**. Every visual property (color,
border, radius, elevation, state) resolves through a CSS custom property. No
component references a raw Tailwind palette color (`bg-blue-500`) or an arbitrary
hex. **Reskinning the entire app — light and dark — is done by editing one file:
`packages/ui/src/styles/globals.css`.**

The current skin is **Oxagen Terracotta**: a **warm-neutral** palette in both
modes — ivory paper (`#FAF9F5`) + crisp white panels in light, warm charcoal
(`#1E1D1B`) page + stepped warm-gray panels in dark (no blue cast anywhere).
**Card and table headers are flat** — they match their surface, separated only
by hairline borders. Colour lives in ONE muted **terracotta primary**
(`--ox-rust`, `#D97757`) — primary CTAs, focus rings, the active-tab underline,
chart-1 — with text links using a deeper **rust** shade (light) / warm apricot
(dark) so link text stays ≥4.5:1. The secondary is a quiet warm-neutral fill,
the hover/selected accent a barely-there terracotta tint. Colour is never
smeared across every surface (the system stays flat — no gradients/glows on
chrome; see §7). The topbar matches the page background. Charts keep a muted
**indigo** for categorical contrast; app-chrome icons (support, notifications,
mobile nav) are neutral. Errors use a true **red** (`hsl 0 72% 51%`) so they
never read as the terracotta primary. The wordmark is lowercase **`oxagen`** in
Space Grotesk (`--font-wordmark`). Surfaces use moderate rounding (`0.5rem`)
and a subtle warm shadow; buttons do not grow on hover (`--button-hover-scale: 1`).

The brand mark gradient stays **tangerine (`#FD9A4B`) → flame (`#F07650`) →
rose (`#EB5C5E`)** (`--_ember-*`) — theme-independent, never recolored.

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
| `--ui-shadow` | `0 1px 2px oklch(0.25 0.015 75 / 0.06)` | Master elevation. Every Tailwind `shadow-*` step reads it. Set `0 0 #0000` for a flat UI. |

---

## 3. Primitives (raw oklch palette)

The only literal colors in the system. Swap these to reskin.

### Brand anchors

| Token | oklch | hex | Purpose |
|---|---|---|---|
| `--_paper` | `oklch(0.982 0.004 95)` | `#FAF9F5` | Light mode background (ivory paper) |
| `--_ink` | `oklch(0.24 0.004 75)` | `#1F1E1D` | Primary text + wordmark ink (warm slate) |
| `--_ink-white` | `oklch(0.948 0.006 67.8)` | `#F1EEEA` | Primary text + wordmark ink (dark, warm) |

### Warm-neutral ramp (stone) — ivory light, warm charcoal dark

| Token | approx hex | Purpose |
|---|---|---|
| `--_stone-50` | `#FCFBF8` | Near-white |
| `--_stone-100` | `#F0EEE6` | Muted background / card-header |
| `--_stone-150` | `#ECEAE2` | Surface-alt (light) |
| `--_stone-200` | `#E6E3DA` | Secondary surfaces |
| `--_stone-300` | `#DBD7CE` | Input borders (light) |
| `--_stone-400` | `#B3AFA7` | muted-foreground (dark) |
| `--_stone-500` | `#77736C` | Tertiary text |
| `--_stone-600` | `#635F58` | Secondary text (light) |
| `--_stone-700` | `#46433E` | Warm graphite |
| `--_stone-800` | `#393836` | Charcoal accent surface (dark) |
| `--_stone-850` | `#2E2D2B` | Popover / muted (dark) |
| `--_stone-900` | `#262624` | Card / sidebar (dark) |
| `--_stone-950` | `#1E1D1B` | Warm charcoal background (dark) |

### Terracotta accent ramp

The `--_violet-*` **names** are retained for zero-churn; the **values** are terracotta.

| Token | oklch | approx hex | Purpose |
|---|---|---|---|
| `--_violet-50` | `oklch(0.965 0.015 45)` | `#FBEFE7` | Accent subtle (light) |
| `--_violet-100` | `oklch(0.925 0.030 45)` | `#F6E0D1` | — |
| `--_violet-200` | `oklch(0.865 0.055 43)` | `#EEC7AE` | — |
| `--_violet-300` | `oklch(0.775 0.085 41)` | `#E0A583` | — |
| `--_violet-400` | `oklch(0.66 0.115 40)` | `#D97757` | **Terracotta** — primary accent |
| `--_violet-500` | `oklch(0.60 0.115 38)` | `#C56545` | — |
| `--_violet-600` | `oklch(0.53 0.105 36)` | `#A85238` | — |
| `--_violet-700` | `oklch(0.46 0.090 35)` | `#8C412C` | — |
| `--_violet-800` | `oklch(0.38 0.070 34)` | `#6D3222` | — |
| `--_violet-900` | `oklch(0.31 0.050 33)` | `#52271B` | — |

### Brand mark (tangerine → flame → rose)

| Token | hex | Note |
|---|---|---|
| `--_ember-gold` | `#FD9A4B` | Gradient start (tangerine) |
| `--_ember-flame` | `#F07650` | Gradient midpoint (flame) |
| `--_ember-crimson` | `#EB5C5E` | Gradient end (rose) |
| `--_ember-navy` | `#0B0D16` | Narwhal ink anchor |

Named brand swatches: `--ox-tangerine` (#FD9A4B) and `--ox-rose` (#EB5C5E)
document the mark hues; `--ox-teak` (#794036) is legacy. `--ox-rust` holds the
**terracotta primary** (#D97757) — the master accent knob.

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
| `--primary` | **terracotta** (#D97757) | **terracotta** (#D97757) |
| `--primary-foreground` | ink (warm slate — white fails AA on terracotta) | ink (warm slate) |
| `--secondary` | quiet warm-neutral fill | warm-clay chip fill |
| `--secondary-foreground` | deep warm gray | ink-white |
| `--muted` / `--muted-foreground` | stone-100 / stone-600 | stone-850 / stone-400 |
| `--accent` / `--accent-foreground` | terracotta tint / deep rust | deep terracotta tint / ink-white |
| `--border` | warm hairline | warm charcoal hairline |
| `--input` | stone-300 | warm charcoal |
| `--ring` | **terracotta** | **terracotta** |
| `--link` | deep rust (≥4.5:1) | warm apricot (≥4.5:1) |
| `--success/-foreground` | moss / white | moss-light / dark |
| `--warning/-foreground` | ochre / dark | ochre-light / dark |
| `--error/-foreground` | true red / white | true red / white |
| `--info/-foreground` | slate / white | slate-light / dark |
| `--chart-1 … 5` | terracotta · muted indigo · moss · ochre · slate | bright equivalents |
| `--sidebar*` | white, terracotta accent | stone-900, terracotta accent |

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

Tune feel via `--motion-*` / `--ease-*` tokens. The Terracotta skin keeps
structural motion: tab slide, overlay enter/exit, control transitions,
`.hover-lift`, `.hover-glow` (accent ring via `--ring`), `.animate-in`, wand
pulse. Button hover-grow is neutralized (`--button-hover-scale: 1`) — hover
feedback is the color-mix background shift. The skin stays **flat** — no
gradients, glows, mesh, or glassmorphism on chrome (depth is a 1px border); the
tangerine→rose gradient is reserved for the brand mark and marketing surfaces
only.

Global `prefers-reduced-motion` kill-switch zeroes animation/transition durations.

---

## 8. Worked reskin example — swap the terracotta accent hue

Goal: change the terracotta accent to a teal, light + dark, in one edit.
`--ox-rust` drives `--primary`, `--ring`, sidebar accent, the active-tab
underline and chart-1, so repointing that anchor re-skins them all.

### Before

```css
/* packages/ui/src/styles/globals.css — :root, PRIMITIVES block */
--ox-rust: oklch(0.66 0.115 40);   /* #D97757 — terracotta */
--_violet-400: oklch(0.66 0.115 40);   /* terracotta (accent-subtle anchor) */
```

### After

```css
--ox-rust: oklch(0.72 0.14 185);   /* teal */
--_violet-400: oklch(0.72 0.14 185);   /* teal */
```

(Also retune `--link`/`--link-hover` in all three theme blocks — they are
hand-picked text-safe shades of the accent hue.)

That's it. `--brand`, `--primary`, `--ring`, `--accent`, sidebar accent, button
backgrounds, focus rings, chart-1 — all re-point to the new hue in both themes
because they resolve through `--_violet-500` / `--_violet-300`. No component file
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
  theme-independent (identical light/dark): the tangerine → flame → rose sweep.
  Recolor them only as a deliberate brand change, in lockstep with the named
  `--ox-tangerine` / `--ox-rose` swatches — never per-theme.
  Only the ink (wordmark strokes) flips via `--_ink` / `--_ink-white`.
- **`global-error.tsx`** — its hardcoded crash-page hexes are NOT theme-aware; if
  the brand hues change, update them there too (no `@oxagen/ui` tokens are loaded
  on the top-level crash boundary).
