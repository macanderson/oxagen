# Oxagen Theme — source of truth

The Oxagen design system is **token-driven**. Every visual property (color,
border, radius, elevation, state) resolves through a CSS custom property. No
component references a raw Tailwind palette color (`bg-blue-500`) or an arbitrary
hex. **Reskinning the entire app — light and dark — is done by editing one file:
`packages/ui/src/styles/globals.css`.**

The current skin is **Oxagen Graphite**: neutral graphite surfaces (a barely-warm
hue at near-zero chroma, so they read as gray/charcoal — never brown) tuned for
DRAMATIC light/dark contrast. Light = off-white page + crisp white panels; dark =
near-black page + stepped charcoal panels. **Card and table headers are dark bars
in both modes.** Warmth is concentrated in the **ember accent** (`--ox-rust`,
`#F87854`) — primary CTAs, focus rings, the active-tab underline, and the ember
mark — and never smeared across every surface. The topbar matches the page
background. Links/charts use a cool **indigo** accent for categorical contrast;
app-chrome icons (support, notifications, mobile nav) are neutral, not blue. The
wordmark is lowercase **`oxagen`** in Space Grotesk (`--font-wordmark`). Surfaces
use moderate rounding (`0.5rem`) and a subtle neutral shadow.

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
| `--_paper` | `oklch(0.971 0.009 82.7)` | `#FAF7F2` | Light mode background (warm paper) |
| `--_ink` | `oklch(0.178 0.014 280)` | `#16181D` | Primary text + wordmark ink (light) |
| `--_ink-white` | `oklch(0.965 0.005 78.3)` | `#F5F4F2` | Primary text + wordmark ink (dark) |

### Violet-tinted neutral ramp (stone)

| Token | approx hex | Purpose |
|---|---|---|
| `--_stone-50` | `#FAFAFD` | Near-white |
| `--_stone-100` | `#F5F3FA` | Muted background |
| `--_stone-150` | `#F2EEF7` | Surface-alt (light) |
| `--_stone-200` | `#E8E2F3` | Secondary surfaces |
| `--_stone-300` | `#D4CAE9` | Input borders (light) |
| `--_stone-400` | `#AEA0CC` | — |
| `--_stone-500` | `#837C92` | Tertiary text / muted-foreground (dark) |
| `--_stone-600` | `#4A4458` | Secondary text (light) |
| `--_stone-700` | `#3A3050` | — |
| `--_stone-800` | `#2A2040` | Accent surface (dark) |
| `--_stone-850` | `#1E1A2E` | Popover / muted (dark) |
| `--_stone-900` | `#15131F` | Card / sidebar (dark) |
| `--_stone-950` | `#0B0D16` | Background (dark) |

### Violet accent ramp

| Token | oklch | approx hex | Purpose |
|---|---|---|---|
| `--_violet-50` | `oklch(0.955 0.025 295)` | `#F1ECFB` | Accent subtle (light) |
| `--_violet-100` | `oklch(0.89 0.06 295)` | `#DDD2F4` | — |
| `--_violet-200` | `oklch(0.81 0.1 295)` | `#C2AFEC` | Accent-foreground (dark) |
| `--_violet-300` | `oklch(0.72 0.14 290)` | `#A78BFA` | **Primary accent (dark)** |
| `--_violet-400` | `oklch(0.62 0.17 290)` | `#8B6BDD` | Brand-2 (dark) |
| `--_violet-500` | `oklch(0.53 0.2 290)` | `#6E48CE` | **Primary accent (light)** — links, focus, CTAs |
| `--_violet-600` | `oklch(0.46 0.18 285)` | `#5733B0` | Brand-2 (light) |
| `--_violet-700` | `oklch(0.39 0.16 285)` | `#452894` | Accent-foreground (light) |
| `--_violet-800` | `oklch(0.32 0.13 280)` | `#361E73` | — |
| `--_violet-900` | `oklch(0.24 0.1 275)` | `#241149` | — |

### Ember mark (fixed — never recolor)

| Token | hex | Note |
|---|---|---|
| `--_ember-gold` | `#F9D423` | Gradient start |
| `--_ember-flame` | `#FF7E5F` | Gradient midpoint |
| `--_ember-crimson` | `#C2185B` | Gradient end (also used as `--error` in light) |

### Status hues

| Token | hex | Meaning |
|---|---|---|
| `--_moss` / `--_moss-light` | `#1D9E75` adj. | Success |
| `--_ochre` / `--_ochre-light` | `#BA7517` adj. | Warning |
| `--_clay` / `--_clay-light` | `#B23A2A` adj. | Error (light uses ember-crimson instead) |
| `--_slate` / `--_slate-light` | `#4E6A7A` adj. | Info |

---

## 4. Core semantic tokens (light / dark)

These ~30 tokens (mapped to `--color-*` → utilities `bg-background`,
`text-foreground`, `border-border`, …) are the reskin surface.

| Token | Light | Dark |
|---|---|---|
| `--background` | `--_paper` (#FAF7F2) | `--_stone-950` (#0B0D16) |
| `--foreground` | `--_ink` (#16181D) | `--_ink-white` (#F5F4F2) |
| `--card` / `--popover` | white / white | stone-900 / stone-850 |
| `--primary` | **violet-500** (#6E48CE) | **violet-300** (#A78BFA) |
| `--primary-foreground` | white | stone-950 |
| `--secondary` | stone-150 | stone-850 |
| `--muted` / `--muted-foreground` | stone-100 / stone-600 | stone-850 / stone-500 |
| `--accent` / `--accent-foreground` | violet-50 / violet-700 | stone-800 / violet-200 |
| `--border` | violet-tinted 50% | violet-tinted 50% (darker) |
| `--input` | stone-300 | violet-tinted |
| `--ring` | **violet-500** | **violet-300** |
| `--success/-foreground` | moss / white | moss-light / dark |
| `--warning/-foreground` | ochre / dark | ochre-light / dark |
| `--error/-foreground` | ember-crimson / white | clay-light / white |
| `--info/-foreground` | slate / white | slate-light / dark |
| `--chart-1 … 5` | violet-500 · ember-flame · moss · ochre · slate | violet-300 equivalents |
| `--sidebar*` | white, violet accent | stone-900, violet accent |

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

Tune feel via `--motion-*` / `--ease-*` tokens. The Nocturne Violet skin keeps
all motion from the system: button hover-grow, tab slide, overlay enter/exit,
control transitions, `.hover-lift`, `.hover-glow` (violet ring), `.animate-in`,
`.stream-caret`, wand pulse.

Global `prefers-reduced-motion` kill-switch zeroes animation/transition durations.

---

## 8. Worked reskin example — swap the violet accent hue

Goal: change the violet accent to a teal, light + dark, in one edit.

### Before

```css
/* packages/ui/src/styles/globals.css — :root, PRIMITIVES block */
--_violet-500: oklch(0.53 0.2 290);   /* #6E48CE — violet */
--_violet-300: oklch(0.72 0.14 290);  /* #A78BFA — violet (dark primary) */
```

### After

```css
--_violet-500: oklch(0.53 0.15 185);  /* teal */
--_violet-300: oklch(0.72 0.12 185);  /* teal (dark primary) */
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
- **Ember mark** — the `--brand-gradient` and `--_ember-*` tokens are
  theme-independent and must **never** be recolored; only the ink (wordmark
  strokes) flips via `--_ink` / `--_ink-white`.
