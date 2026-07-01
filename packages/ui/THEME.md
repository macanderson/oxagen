# Oxagen Theme — source of truth

The Oxagen design system is **token-driven**. Every visual property (color,
border, radius, elevation, state) resolves through a CSS custom property. No
component references a raw Tailwind palette color (`bg-blue-500`) or an arbitrary
hex. **Reskinning the entire app — light and dark — is done by editing one file:
`packages/ui/src/styles/globals.css`.**

The current skin is **Oxagen Tangerine**: a **split-hue neutral** palette — WARM
off-white surfaces in light, COOL narwhal near-black surfaces in dark — tuned for
DRAMATIC light/dark contrast. Light = warm paper page + crisp white panels; dark =
narwhal (`#0B0D16`) page + stepped inky-blue panels. **Card and table headers are
dark bars in both modes.** Colour lives in the **tangerine primary** (`--ox-rust` →
`--ox-tangerine`, `#FD9A4B`) — primary CTAs, focus rings, the active-tab underline,
default badges, the brand mark start — plus a **rose secondary** (`--ox-rose`,
`#EB5C5E`, secondary buttons/badges + the brand-mark end) and a **teak accent**
(`#794036`) for hover/selected surfaces. Colour is never smeared across every
surface (the system stays flat — no gradients/glows on chrome; see §7). The topbar
matches the page background. Text links/charts use a cool **indigo** accent for
categorical contrast; app-chrome icons (support, notifications, mobile nav) are
neutral, not blue. Errors use a true **red** (`hsl 0 72% 51%`) so they never read
as the tangerine primary. The wordmark is lowercase **`oxagen`** in Space Grotesk
(`--font-wordmark`). Surfaces use moderate rounding (`0.5rem`) and a subtle shadow.

The brand mark gradient is **tangerine → flame (`#F07650`) → rose**
(`--_ember-*`).

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
| `--ui-shadow` | `0 1px 2px oklch(0.24 0.1 275 / 0.06)` | Master elevation. Every Tailwind `shadow-*` step reads it. Set `0 0 #0000` for a flat UI. |

---

## 3. Primitives (raw oklch palette)

The only literal colors in the system. Swap these to reskin.

### Brand anchors

| Token | oklch | hex | Purpose |
|---|---|---|---|
| `--_paper` | `oklch(0.980 0.004 84.6)` | `#F8F6F1` | Light mode background (warm paper) |
| `--_ink` | `oklch(0.182 0.019 266.5)` | `#101319` | Primary text + wordmark ink (light, cool) |
| `--_ink-white` | `oklch(0.948 0.006 67.8)` | `#F1EEEA` | Primary text + wordmark ink (dark, warm) |

### Split-hue neutral ramp (stone) — warm light, cool narwhal dark

| Token | approx hex | hue | Purpose |
|---|---|---|---|
| `--_stone-50` | `#FCFBF9` | warm | Near-white |
| `--_stone-100` | `#F4F2EE` | warm | Muted background / card-header |
| `--_stone-150` | `#EFEDE8` | warm | Surface-alt (light) |
| `--_stone-200` | `#E7E4DE` | warm | Secondary surfaces |
| `--_stone-300` | `#DCD8D1` | warm | Input borders (light) |
| `--_stone-400` | `#B4B0A9` | warm | muted-foreground (dark) |
| `--_stone-500` | `#78767E` | cool | Tertiary text |
| `--_stone-600` | `#6A6874` | cool | Secondary text (light) |
| `--_stone-700` | `#45454E` | cool | Graphite |
| `--_stone-800` | `#33343D` | cool | Narwhal accent surface (dark) |
| `--_stone-850` | `#23252E` | cool | Popover / muted (dark) |
| `--_stone-900` | `#191B23` | cool | Card / sidebar (dark) |
| `--_stone-950` | `#0B0D16` | cool | Narwhal background (dark) |

### Tangerine accent ramp

The `--_violet-*` **names** are retained for zero-churn; the **values** are tangerine.

| Token | oklch | approx hex | Purpose |
|---|---|---|---|
| `--_violet-50` | `oklch(0.965 0.020 60)` | `#FCEBDA` | Accent subtle (light) |
| `--_violet-100` | `oklch(0.917 0.050 59.5)` | `#FBD9BB` | — |
| `--_violet-200` | `oklch(0.852 0.093 58.5)` | `#F9BE8B` | — |
| `--_violet-300` | `oklch(0.803 0.128 57.1)` | `#FCA95F` | — |
| `--_violet-400` | `oklch(0.775 0.150 56.4)` | `#FD9A4B` | **Tangerine** — primary accent |
| `--_violet-500` | `oklch(0.699 0.168 49.5)` | `#E87F32` | — |
| `--_violet-600` | `oklch(0.618 0.175 42.3)` | `#CB621C` | — |
| `--_violet-700` | `oklch(0.508 0.144 38.9)` | `#A24E1B` | — |
| `--_violet-800` | `oklch(0.398 0.098 37.5)` | `#7A3D1C` | — |
| `--_violet-900` | `oklch(0.313 0.065 35.1)` | `#5A2E18` | — |

### Brand mark (tangerine → flame → rose)

| Token | hex | Note |
|---|---|---|
| `--_ember-gold` | `#FD9A4B` | Gradient start (tangerine) |
| `--_ember-flame` | `#F07650` | Gradient midpoint (flame) |
| `--_ember-crimson` | `#EB5C5E` | Gradient end (rose) |
| `--_ember-navy` | `#0B0D16` | Narwhal ink anchor |

Named brand swatches: `--ox-tangerine` (#FD9A4B), `--ox-rose` (#EB5C5E),
`--ox-teak` (#794036). `--ox-rust` is retained as a legacy name → tangerine.

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
| `--background` | `--_paper` (#F8F6F1) | `--_stone-950` (#0B0D16) |
| `--foreground` | `--_ink` (#101319) | `--_ink-white` (#F1EEEA) |
| `--card` / `--popover` | white / white | stone-900 / stone-850 |
| `--primary` | **tangerine** (#FD9A4B) | **tangerine** (#FD9A4B) |
| `--primary-foreground` | ink (dark) | ink (dark) |
| `--secondary` | **rose** (deep, #C63C42) | **rose** (bright, #EB5C5E) |
| `--secondary-foreground` | white | ink (dark) |
| `--muted` / `--muted-foreground` | stone-100 / stone-600 | stone-850 / stone-400 |
| `--accent` / `--accent-foreground` | pale teak / deep teak | teak (#794036 adj.) / ink-white |
| `--border` | warm hairline 40 18% 86% | cool narwhal 220 18% ~ |
| `--input` | stone-300 | cool narwhal |
| `--ring` | **tangerine** | **tangerine** |
| `--success/-foreground` | moss / white | moss-light / dark |
| `--warning/-foreground` | ochre / dark | ochre-light / dark |
| `--error/-foreground` | true red / white | true red / white |
| `--info/-foreground` | slate / white | slate-light / dark |
| `--chart-1 … 5` | tangerine · indigo · moss · ochre · slate | bright equivalents |
| `--sidebar*` | white, tangerine accent | stone-900, tangerine accent |

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

Tune feel via `--motion-*` / `--ease-*` tokens. The Tangerine skin keeps all
motion from the system: button hover-grow, tab slide, overlay enter/exit, control
transitions, `.hover-lift`, `.hover-glow` (tangerine ring), `.animate-in`,
`.stream-caret`, wand pulse. The skin stays **flat** — no gradients, glows, mesh,
or glassmorphism on chrome (depth is a 1px border); the tangerine→rose gradient is
reserved for the brand mark and marketing surfaces only.

Global `prefers-reduced-motion` kill-switch zeroes animation/transition durations.

---

## 8. Worked reskin example — swap the tangerine accent hue

Goal: change the tangerine accent to a teal, light + dark, in one edit. `--ox-rust`
(→ `--ox-tangerine`) drives `--primary`, `--ring`, sidebar accent, the active-tab
underline and chart-1, so repointing the tangerine anchor re-skins them all.

### Before

```css
/* packages/ui/src/styles/globals.css — :root, PRIMITIVES block */
--ox-tangerine: oklch(0.775 0.150 56.4);   /* #FD9A4B — tangerine */
--_violet-400: oklch(0.775 0.150 56.4);    /* tangerine (accent-subtle anchor) */
```

### After

```css
--ox-tangerine: oklch(0.72 0.14 185);   /* teal */
--_violet-400: oklch(0.72 0.14 185);    /* teal */
```

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
  Recolor them only as a deliberate brand change (as in the Tangerine reskin), in
  lockstep with the named `--ox-tangerine` / `--ox-rose` swatches — never per-theme.
  Only the ink (wordmark strokes) flips via `--_ink` / `--_ink-white`.
- **`global-error.tsx`** — its hardcoded crash-page hexes are NOT theme-aware; if
  the brand hues change, update them there too (no `@oxagen/ui` tokens are loaded
  on the top-level crash boundary).
