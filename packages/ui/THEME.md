# Oxagen Theme — source of truth

The Oxagen design system is **token-driven**. Every visual property (color,
border, radius, elevation, state) resolves through a CSS custom property. No
component references a raw Tailwind palette color (`bg-blue-500`) or an arbitrary
hex. **Reskinning the entire app — light and dark — is done by editing one file:
`packages/ui/src/styles/globals.css`.**

The current skin is **Nocturne Violet** (source: `docs/brand/` — tokens in
`docs/brand/tokens.css`): warm paper (`#FAF7F2`) + crisp white panels in
light, deep nocturne navy-violet (`#0B0D16` page, `#15131F` panels, `#1E1A2E`
raised) in dark. **Card and table headers are flat** — they match their
surface, separated only by hairline borders. Colour lives in ONE **violet
primary** (`--ox-violet`, `#6E48CE` light / `--ox-violet-bright`, `#A78BFA`
dark) — primary CTAs, focus rings, the active-tab underline, links, chart-1.
The secondary is a quiet violet-neutral fill, the hover/selected accent a
barely-there violet tint, and borders are violet hairlines
(`rgba(54,30,115,.14)` light / `rgba(167,139,250,.16)` dark). Colour is never
smeared across every surface (the system stays flat — no gradients/glows on
chrome; see §7). The topbar matches the page background. Chart-2 is the warm
**ember flame** for categorical contrast (the old indigo sits too close to
violet); app-chrome icons (support, notifications, mobile nav) are neutral.
Errors reuse the **ember crimson** (`#C2185B`), which never reads as the
violet primary. The wordmark is lowercase **`oxagen`** in Space Grotesk
(`--font-wordmark`). Surfaces use moderate rounding (`0.5rem`) and a subtle
cool shadow; buttons do not grow on hover (`--button-hover-scale: 1`).

The brand mark gradient is the ember sweep — **gold (`#F9D423`) → flame
(`#FF7E5F`) → crimson (`#C2185B`)** (`--_ember-*`) — theme-independent, never
recolored, warm in both modes ("warm logo, cool ground").

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

### Violet-neutral ramp (stone) — violet-tinted paper light, nocturne dark

| Token | approx hex | Purpose |
|---|---|---|
| `--_stone-50` | `#FBFAFD` | Near-white |
| `--_stone-100` | `#F2EEF7` | Muted background / card-header (brand surface-alt) |
| `--_stone-150` | `#EDE8F3` | Surface-alt (light) |
| `--_stone-200` | `#E6E0EE` | Secondary surfaces |
| `--_stone-300` | `#D9D2E4` | Input borders (light) |
| `--_stone-400` | `#B6AFC9` | muted-foreground (dark) |
| `--_stone-500` | `#837C92` | Tertiary text |
| `--_stone-600` | `#4A4458` | Secondary text (light) |
| `--_stone-700` | `#3B3548` | Violet graphite |
| `--_stone-800` | `#2A2440` | Raised violet accent surface (dark) |
| `--_stone-850` | `#1E1A2E` | Popover / muted (dark) |
| `--_stone-900` | `#15131F` | Card / sidebar (dark) |
| `--_stone-950` | `#0B0D16` | Near-black navy background (dark) |

### Violet accent ramp

The `--_violet-*` names carry **true violet values** (docs/brand/tokens.css).

| Token | oklch | hex | Purpose |
|---|---|---|---|
| `--_violet-50` | `oklch(0.951 0.021 301.1)` | `#F1ECFB` | Accent subtle (light) |
| `--_violet-100` | `oklch(0.883 0.048 300.2)` | `#DDD2F4` | — |
| `--_violet-200` | `oklch(0.791 0.087 298.7)` | `#C2AFEC` | Link hover (dark) |
| `--_violet-300` | `oklch(0.709 0.159 293.5)` | `#A78BFA` | **Accent on dark** / links (dark) |
| `--_violet-400` | `oklch(0.612 0.167 293.8)` | `#8B6BDD` | — |
| `--_violet-500` | `oklch(0.519 0.196 291.0)` | `#6E48CE` | **Primary accent** (light) / links |
| `--_violet-600` | `oklch(0.443 0.186 289.8)` | `#5733B0` | Link hover (light) |
| `--_violet-700` | `oklch(0.383 0.161 289.6)` | — | — |
| `--_violet-800` | `oklch(0.324 0.137 289.4)` | `#361E73` | Border base / accent ink |
| `--_violet-900` | `oklch(0.243 0.098 293.3)` | `#241149` | — |

### Brand mark (gold → flame → crimson)

| Token | hex | Note |
|---|---|---|
| `--_ember-gold` | `#F9D423` | Gradient start (gold) |
| `--_ember-flame` | `#FF7E5F` | Gradient midpoint (flame) |
| `--_ember-crimson` | `#C2185B` | Gradient end (crimson) |
| `--_ember-navy` | `#0B0D16` | Nocturne navy ink anchor |

Named brand swatches: `--ox-violet` (#6E48CE) and `--ox-violet-bright`
(#A78BFA) are the master accent knobs (light / dark grounds). `--ox-rust` is a
deprecated alias of `--ox-violet`; `--ox-tangerine` / `--ox-rose` are legacy
names re-pointed at the ember gold / crimson stops; `--ox-teak` is legacy.

### Status hues

| Token | hex | Meaning |
|---|---|---|
| `--_moss` / `--_moss-light` | `#1D9E75` | Success |
| `--_ochre` / `--_ochre-light` | `#BA7517` | Warning |
| `--_clay` / `--_clay-light` | `#C2185B` adj. | Error — **ember crimson** in both modes |
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
| `--primary` | **violet** (#6E48CE) | **bright violet** (#A78BFA) |
| `--primary-foreground` | white | ink (navy — white fails AA on the bright violet) |
| `--secondary` | quiet violet-neutral fill | violet chip fill |
| `--secondary-foreground` | deep violet-gray | ink-white |
| `--muted` / `--muted-foreground` | stone-100 / stone-600 | stone-850 / stone-400 |
| `--accent` / `--accent-foreground` | violet tint / deep violet | deep violet tint / ink-white |
| `--border` | violet hairline (`rgba(54,30,115,.14)`) | violet hairline (`rgba(167,139,250,.16)`) |
| `--input` | stone-300 | violet hairline (stronger) |
| `--ring` | **violet** | **bright violet** |
| `--link` | violet-500 (≥4.5:1) | violet-300 #A78BFA (≥4.5:1) |
| `--success/-foreground` | moss / white | moss-light / dark |
| `--warning/-foreground` | ochre / dark | ochre-light / dark |
| `--error/-foreground` | ember crimson / white | crimson-light / white |
| `--info/-foreground` | slate / white | slate-light / dark |
| `--chart-1 … 5` | violet · ember flame · moss · ochre · slate | bright equivalents |
| `--sidebar*` | white, violet accent | stone-900, bright violet accent |

**Accent-mode caveat:** unlike the previous skin, the accent hue **differs
between modes** (#6E48CE light / #A78BFA dark, with white vs. navy-ink
foregrounds). Any component token that carries the accent (`--tab-border-active`,
`--button-primary-fg/-ring`, `--input-*-focus/-ring`, `--control-*`,
`--app-link-active-fg`, `--brand/-foreground`) is therefore re-declared in both
dark scopes — see the "accent flip" section in each dark block.

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

Tune feel via `--motion-*` / `--ease-*` tokens. The Nocturne skin keeps
structural motion: tab slide, overlay enter/exit, control transitions,
`.hover-lift`, `.hover-glow` (accent ring via `--ring`), `.animate-in`, wand
pulse. Button hover-grow is neutralized (`--button-hover-scale: 1`) — hover
feedback is the color-mix background shift. The skin stays **flat** — no
gradients, glows, mesh, or glassmorphism on chrome (depth is a 1px border); the
gold→crimson ember gradient is reserved for the brand mark and marketing
surfaces only.

Global `prefers-reduced-motion` kill-switch zeroes animation/transition durations.

---

## 8. Worked reskin example — swap the violet accent hue

Goal: change the violet accent to a teal, light + dark, in one edit.
`--ox-violet` (light grounds) and `--ox-violet-bright` (dark grounds) drive
`--primary`, `--ring`, sidebar accent, the active-tab underline and chart-1,
so repointing those anchors re-skins them all.

### Before

```css
/* packages/ui/src/styles/globals.css — :root, PRIMITIVES block */
--ox-violet: oklch(0.519 0.196 291.0);        /* #6E48CE — violet */
--ox-violet-bright: oklch(0.709 0.159 293.5); /* #A78BFA — violet on dark */
```

### After

```css
--ox-violet: oklch(0.55 0.14 185);        /* teal */
--ox-violet-bright: oklch(0.75 0.12 185); /* teal on dark */
```

(Also retune `--link`/`--link-hover`, the `--_violet-*` ramp, and the
violet-tinted `--secondary`/`--accent` washes in all three theme blocks — they
are hand-picked text-safe shades of the accent hue.)

`--brand`, `--primary`, `--ring`, `--accent`, sidebar accent, button
backgrounds, focus rings, chart-1 — all re-point to the new hue in both themes.
No component file changes.

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
  theme-independent (identical light/dark): the gold → flame → crimson ember
  sweep (docs/brand — "ember stays ember in both modes"). Recolor them only as
  a deliberate brand change, in lockstep with the SVG stops in
  `packages/ui/src/components/brand.tsx` / `hex-field.tsx` and the assets in
  `docs/brand/` — never per-theme.
  Only the ink (wordmark strokes) flips via `--_ink` / `--_ink-white`.
- **`global-error.tsx`** — its hardcoded crash-page hexes are NOT theme-aware; if
  the brand hues change, update them there too (no `@oxagen/ui` tokens are loaded
  on the top-level crash boundary).
