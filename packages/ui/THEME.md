# Oxagen Theme — source of truth

The Oxagen design system is **token-driven**. Every visual property (color,
border, radius, elevation, state) resolves through a CSS custom property. No
component references a raw Tailwind palette color (`bg-blue-500`) or an arbitrary
hex. **Reskinning the entire app — light and dark — is done by editing one file:
`packages/ui/src/styles/globals.css`.**

The current skin is **enterprise · earth · neutral**: a monochrome-ink system on
a warm paper/stone ramp. Flat surfaces — no gradients, no jewel tones, no
glassmorphism, no drop shadows, no rounded corners. The one warm note is the
brand color, **paper** (`#E6C8A6`). Motion is fully retained.

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
| `--ui-radius` | `0px` | Master corner radius. The whole `--radius-*` scale derives from it; `0px` = hard square corners. Set `0.5rem` to round everything. |
| `--ui-shadow` | `0 0 #0000` | Master elevation. Every Tailwind `shadow-*` step reads it; the transparent default keeps the UI flat. Set a real shadow to re-enable elevation globally. |

These are why ~480 `rounded-*` and ~55 `shadow-*` class sites needed **no edits**:
they all resolve through these two knobs.

---

## 3. Primitives (raw oklch palette)

The only literal colors in the system. Swap these to reskin.

| Token | oklch | hex |
|---|---|---|
| `--_paper` | `oklch(0.85 0.057 70.4)` | `#E6C8A6` |
| `--_ink` | `oklch(0.263 0.006 56.1)` | `#272422` |
| `--_ink-white` | `oklch(0.96 0.008 73.7)` | `#F5F1EC` |
| `--_stone-50 … 950` | warm-neutral ramp | `#FAF7F2` … `#1B1916` |
| `--_paper-200 … 800` | tan accent ramp | `#F3E6D3` … `#997449` |
| `--_clay` / `--_clay-light` | `oklch(0.52 0.159 30.7)` / `…0.593…` | `#B23A2A` / `#C9543F` (error) |
| `--_moss` / `--_moss-light` | `oklch(0.528 0.079 132)` / `…0.648…` | `#5A7544` / `#7C9A5E` (success) |
| `--_ochre` / `--_ochre-light` | `oklch(0.667 0.124 73)` / `…0.747…` | `#C2872E` / `#D9A23F` (warning) |
| `--_slate` / `--_slate-light` | `oklch(0.508 0.042 234)` / `…0.618…` | `#4E6A7A` / `#6E8A9A` (info) |
| `--_terracotta` / `-light` | `oklch(0.583 0.121 44.5)` / `…0.659…` | `#B5613A` / `#CC7A50` |

Semantic anchors: `--brand` = `--_paper`, `--brand-foreground` = `--_ink`,
`--ink-light` = `--_ink-white`, `--ink-dark` = `--_ink`.

---

## 4. Core semantic tokens (light / dark)

These ~30 tokens (mapped to `--color-*` → utilities `bg-background`,
`text-foreground`, `border-border`, …) are the reskin surface. Light value is on
`:root`; dark on `.dark`.

| Token | Light | Dark |
|---|---|---|
| `--background` | stone-150 | `#1C1A18` |
| `--foreground` | ink | ink-white |
| `--card` / `--popover` | stone-50 | ink / `#2F2B27` |
| `--primary` | ink | ink-white |
| `--primary-foreground` | ink-white | ink |
| `--secondary` | stone-200 | `#332E29` |
| `--muted` / `--muted-foreground` | stone-150 / stone-600 | `#2A2622` / `#A89A86` |
| `--accent` / `--accent-foreground` | paper-300 / deep tan | `#3A3329` / paper |
| `--border` | `#E2D9CB` | `#38332C` |
| `--input` | stone-300 | `#3D372F` |
| `--ring` | ink | paper |
| `--success/-foreground` | moss / ink-white | moss-light / dark |
| `--warning/-foreground` | ochre / dark | ochre-light / dark |
| `--error/-foreground` | clay / white | clay-light / white |
| `--info/-foreground` | slate / white | slate-light / dark |
| `--chart-1 … 5` | ink · paper-700 · moss · terracotta · slate | lifted equivalents |
| `--sidebar*` | warm paper-white surface | deep ink surface |

`--destructive` is kept as an alias of `--error` for back-compat.

---

## 5. Component tokens

Declared once on `:root`, referencing core tokens (so they flip automatically).
Each is mapped to a `--color-*` utility of the same name.

**Sidebar:** `--sidebar-bg/-fg`, `--sidebar-nav-label-fg`,
`--sidebar-nav-link-fg`, `--sidebar-nav-link-hover-bg/-fg`,
`--sidebar-nav-link-active-bg/-fg`, `--sidebar-border-width` (`1px`),
`--sidebar-width` (`16rem`), `--sidebar-icon-width` (`3.5rem`).

**App chrome:** `--app-panel-bg/-fg`, `--app-topbar-bg/-fg/-border`,
`--app-link-fg`, `--app-link-hover-fg`, `--app-link-active-fg`.

**Tabs:** `--tab-fg` / `-hover` / `-active`, `--tab-border` / `-hover` /
`-active`, `--tab-border-width` (`2px`). Rest border is constant width so the
active underline never shifts layout. Border width is applied with the arbitrary
syntax `border-b-[length:var(--tab-border-width)]`.

**Buttons** (`primary` + `default`): `--button-primary-bg/-fg/-border/-hover-bg/
-active-bg/-ring` and `--button-default-bg/-fg/-border/-hover-bg/-active-bg/
-ring`, plus `--button-disabled-bg/-fg`. Hover/active adapt via `color-mix(... ,
var(--background))` so they flip correctly in dark with no re-declaration.

**Inputs / textareas:** `--input-bg`, `--input-fg`, `--input-placeholder`,
`--input-border`, `--input-border-hover`, `--input-border-focus`, `--input-ring`,
`--input-disabled-bg/-fg`, `--input-invalid-border/-ring`.

**Select / Menu:** `--menu-popup-bg/-fg/-border`, `--menu-item-fg`,
`--menu-item-highlighted-bg/-fg`, `--menu-item-disabled-fg`,
`--menu-item-selected-bg/-fg`, `--menu-separator`, `--menu-group-label-fg`. The
select trigger mirrors the `--input-*` tokens.

**Checkbox / Radio / Switch:** `--control-track-bg`,
`--control-track-bg-checked`, `--control-indicator` (checkmark on a checked
fill), `--control-thumb` (switch knob), `--control-border`, `--control-ring`.
The radio dot reuses `--control-track-bg-checked`.

**Tooltip / Dialog / Badge / Overlay:** `--tooltip-bg/-fg/-border` (inverted —
ink surface on light), `--dialog-bg/-fg/-border`, `--overlay-scrim` (the modal
scrim), `--badge-bg/-fg/-border`.

---

## 6. Base UI state-wiring rules

The components use **Base UI** (`@base-ui/react`), not Radix. State is styled via
Base UI data-attributes, not conditional class strings:

| Primitive | Attribute | Token utility |
|---|---|---|
| Tabs | `data-[selected]` | `border-tab-border-active`, `text-tab-fg-active` |
| Menu / Select item | `data-[highlighted]` | `bg-menu-item-highlighted-bg` |
| Select item | `data-[selected]` | `bg-menu-item-selected-bg` |
| Select trigger / submenu | `data-[popup-open]` | open-state styling |
| Checkbox / Switch / Radio | `data-[checked]` | `bg-control-track-bg-checked` |
| Field / input | `data-[invalid]` + `aria-[invalid=true]` | `border-input-invalid-border` |
| Any | `data-[disabled]` | disabled treatment |

- Border **width** tokens use `border-[length:var(--token)]` (Tailwind won't
  generate a width utility from a color token).
- Elements whose border *appears* on a state (tabs, focused inputs) keep a
  constant-width border at rest so the highlight never shifts layout.

---

## 7. Motion policy — **motion is retained**

Motion is **not** a gradient/shadow/radius treatment, so it stays. Tune feel via
the `--motion-*` / `--ease-*` tokens (`--ease-entry`, `--ease-hover`,
`--ease-exit`, `--motion-micro/base/overlay/entry`, `--button-hover-scale`).

- **Buttons** — transform-only hover-grow (`hover:scale-[var(--button-hover-scale)]`).
- **Tabs** — sliding active-indicator (`TabsIndicator`) + per-panel fade-in.
- **Overlays** (menu, select, dialog) — enter/exit opacity+transform transitions
  via Base UI `data-[starting-style]` / `data-[ending-style]`.
- **Controls** — switch track/thumb and radio ring transitions.
- **Utilities** — `.hover-lift` (transform), `.hover-glow` (flat ring),
  `.animate-in` (`fade-in` keyframe), `.stream-caret` (typewriter blink), the
  wand pulse, and the field-fill ring pulse.
- The global `prefers-reduced-motion` kill-switch zeroes animation/transition
  durations for users who ask for it.

What changed vs. the old skin: motions that were **glows** now animate a **flat
ring** (no blur); nothing was removed.

---

## 8. Worked reskin example — swap the brand hue

Goal: change the warm-paper brand to a muted sage, light + dark, in one edit.

```css
/* packages/ui/src/styles/globals.css — :root, PRIMITIVES block */

/* before */
--_paper: oklch(0.85 0.057 70.4);   /* #E6C8A6 warm tan */

/* after */
--_paper: oklch(0.84 0.045 145);    /* muted sage */
```

That's it. `--brand`, `--accent` (light), the dark `--accent-foreground`/
`--ring`/`--sidebar-accent-foreground`, every `bg-brand`/`text-brand-foreground`
surface, the brand-2 accent, and the field-fill ring all re-point to the new hue
in both themes — because they all resolve through `--_paper` → `--brand`. No
component file changes.

To re-introduce rounded corners or shadows globally, edit the two control knobs
(§2): `--ui-radius: 0.5rem;` and `--ui-shadow: 0 1px 2px oklch(0 0 0 / .12);`.

---

## 9. Documented exceptions

- **`.ox-grid-dots`** — the knowledge-graph canvas backdrop is a token-driven
  dotted texture (a `radial-gradient` of `var(--foreground)` at low alpha). It is
  a functional grid, not a decorative brand gradient, so it is kept.
- **`.tabs-edge-fade`** — a `linear-gradient` *mask* (not a painted gradient) that
  fades the horizontal tab strip edges. Structural, kept.
- **`global-error.tsx`** — the top-level crash page renders entirely outside the
  app (no theme context, possibly no CSS), so it uses hardcoded earthy hexes
  rather than tokens by necessity.
- **`field-fill-transition.tsx` / wand button** — self-contained feature keyframes
  (`field-fill-glow`, `wand-ring-pulse`) live inline / in the app globals; both
  are flat (ring/scale, no blur) and motion-only.
- **Not-yet-built primitives** — `checkbox`, `tooltip`, and a Base UI `field`
  wrapper don't exist in `@oxagen/ui` yet (the app uses its own field system).
  Their tokens (`--control-*`, `--tooltip-*`, `--input-invalid-*`) are already
  defined here, so building them later is a pure component task with no token work.
```
