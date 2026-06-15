# Oxagen Design System

> **Oxagen** gives AI agents secure, role-aware **context** — drawn from a typed
> **Neo4j knowledge graph**, governed by the same RBAC that bounds your humans.
> Developer-focused. Jewel-tone, high-contrast, futuristic.

This project is the brand + product design system: design tokens, fonts, brand
assets, reusable React UI primitives, foundation specimen cards, and a
click-through recreation of the Oxagen app.

---

## What Oxagen is

Oxagen is a B2B platform that supplies AI agents with **secure context**. The
core idea: instead of dumping raw documents into a model, Oxagen models your
world as a **typed knowledge graph** — entities (users, documents, services,
policies, resources) connected by **permission-checked edges** — and every
retrieval an agent performs is **scoped to the caller's access grants** (RBAC).
The product is heavily developer- and security-oriented: MCP servers, API
tokens, webhooks, SSO/SCIM, audit logs, tenant isolation (RLS), and an
approval flow for agent tool calls.

**Primary surfaces (from the codebase):**
- **Workspace** — *Ask* (agent chat), *Knowledge* (Sources · Graph · Memories),
  *Automation*, *Activity*, *Studio*, *Workflows*, *Settings*.
- **Organization / governance** — *Members*, *Access* (Grants · Roles · Policies
  · Requests · Sessions · Principals), *Security* (MFA · Audit · Compliance ·
  Incidents · SSO · SCIM · Trust), *Billing*, *Developer* (MCP · Webhooks · Docs
  · Tokens).
- **Auth & onboarding** — login / signup / forgot-password, new-organization.

### Sources this system was built from
- **`app/`** — the Next.js product app (`oxagenai/oxagen-monorepo`, `apps/app`).
  Read for screen structure, the chat/composer, knowledge-graph viewer, RBAC
  roles page, sidebar IA (`src/lib/sidebar.ts`), and shell.
- **`ui/`** — the shared component package (`@oxagen/ui`, `packages/ui`). Read
  for `globals.css`, `tokens.css`, `oxagen-tokens.css`, `gradient-border.css`,
  Button/Badge/Card/Input and the brand marks (`brand.tsx`).
- **`uploads/`** — the licensed **Aeonik** variable fonts + `aeonik.css`, and the
  gradient app icon (`icon.svg`).

> ⚠️ **Brand-color note.** The shipped `packages/ui/src/styles/tokens.css` is
> deliberately **desaturated to monochrome** (a temporary product decision — the
> file says so and explains how to restore color). The **true Oxagen brand** is
> jewel-toned, and is preserved in the repo's `oxagen-tokens.css`,
> `gradient-border.css`, and the gradient app icon. Per the brief
> ("jewel tone, bright, high-contrast, futuristic"), this design system
> **restores and systematizes that jewel-tone identity**.

---

## Content fundamentals

How Oxagen writes. The voice is **precise, technical, and quietly confident** —
it talks to engineers and security teams as peers, never markety.

- **Person & address.** Second person ("**your** sources", "ask anything") for
  the user; the product refers to itself as "**Oxagen**" or "the agent", not
  "we". Imperative for actions ("Run agent", "Approve", "Connect a source").
- **Tone.** Plain, exact, reassuring on security. Leads with the *guarantee*
  ("Retrieval is RBAC-enforced", "the agent only sees what you're allowed to").
  No hype words, no exclamation points.
- **Casing.** **Sentence case** everywhere — headings, buttons, menu items
  ("New custom role", not "New Custom Role"). Mono **eyebrows are UPPERCASE**
  with wide tracking. Product nouns are capitalized as proper features
  (Knowledge, Access, Ask, Studio).
- **Numbers & IDs.** Tabular/mono for metrics and money (`$248.10`, `18.2k
  edges`, `318ms`). Entity IDs are mono with a typed prefix:
  `prn_8fa21c` (principal), `doc_41be09`, `svc_github`, `pol_read_eng`.
- **Microcopy examples.** "Sign in to your Oxagen workspace." · "No approved
  edges yet — review pending inferences above to build your knowledge graph." ·
  "Preview · not yet wired to live data." · "Thought for 4s · scoped retrieval
  to caller's read grants."
- **Emoji.** **None.** The brand never uses emoji. Status is carried by typed
  color dots, Lucide icons, and badges — not pictographs.
- **Jargon is welcome** (RLS, RBAC, MCP, edges, principals, inference) because
  the audience is technical — but it's always used correctly.

---

## Visual foundations

The system is **dark-first** ("deep space"), where the jewel tones glow; a clean
light theme is also provided. The feeling is *a precise instrument*, not a toy.

- **Color.** A jewel **triad** — **Cyan `#7CE8F4`** (knowledge / calm),
  **Violet `#7C5AED`** (primary brand), **Cosmos `#DF2A5D`** (energy) — radiating
  from a **deep indigo `#3C1F89` → cyan** core (the app icon's gradient).
  Surfaces are cool, near-black, slightly blue-violet tinted neutrals
  (`--ink-*`). Violet is the primary action color; cyan accents knowledge-graph
  surfaces; semantic status (info/success/warning/danger) is retained for
  functional signals only.
- **Signature gradients.** *Nebula* (cyan→violet→cosmos), *Aurora*
  (cyan→violet), *Cosmos* (indigo→violet→cyan), *Sunset* (cosmos→violet). Used
  for the brand tile, the hero CTA (`Button variant="gradient"`), active tab
  indicators, gradient-clipped display text, and the masked hairline
  `.ox-gradient-ring` border. **Used sparingly** — one gradient moment per
  surface; the rest is flat neutral.
- **Type.** **Aeonik Fono** for display/headings (medium weight, tight −0.02em
  tracking), **Aeonik** for UI + body, **Aeonik Mono** for code, eyebrows, IDs
  and metrics. Mono carries real semantic weight in this developer product.
- **Backgrounds.** Deep flat ink, occasionally lifted by a subtle **radial mesh
  bloom** (`.ox-mesh`, violet/cyan/cosmos blooms at low opacity) on hero/auth
  surfaces, and a **dotted graph grid** (`.ox-grid-dots`) behind the
  knowledge-graph canvas. No photography; the imagery *is* the graph.
- **Borders & corners.** Hairline 1px borders (`--border` ≈ `#262531` on dark).
  Radii: 6 (chips), 8 (controls), 12 (cards), 16 (composer/panels), 24 (hero).
- **Cards.** Flat `--card` surface, 1px border, soft `--shadow-sm`; the
  *featured* card gets a violet **glow** ring (`--glow-violet`) rather than a
  heavier shadow. Optional nebula hairline via `.ox-gradient-ring`. No
  colored-left-border cards, no heavy drop shadows.
- **Elevation.** On dark, depth reads as **glow** (jewel focus rings) more than
  shadow. `--shadow-sm → xl` exist for menus/overlays; `--glow-violet` /
  `--glow-cyan` are the brand focus treatment.
- **Motion.** Restrained. Easings lifted verbatim from the product:
  `--ease-entry` (decelerate, `cubic-bezier(.16,1,.3,1)`), `--ease-hover`
  (`.22,1,.36,1`), `--ease-exit` (accelerate). Durations 160/220/200/320ms.
  Fades + small rises; **no bounce**, no infinite decorative loops on content.
- **Hover / press.** Hover = subtle `brightness(1.08)` + 1px lift; press =
  settle back + `scale(.98)`. Nav items reveal a gradient left-accent bar when
  active. Switches gain a violet glow when on.
- **Transparency & blur.** Used lightly — `color-mix(... transparent)` tints for
  badges/legends; the product itself removed glassmorphism in favor of **opaque**
  token surfaces, so prefer solid `--card`/`--popover` over see-through panels.

---

## Iconography

- **Lucide** (`lucide-react`) is the product's icon set — thin (≈1.75–2px
  stroke), rounded, monochrome, `currentColor`. The UI kits load Lucide from the
  pinned CDN (`lucide@0.469.0`) and the `Icon` helper (`ui_kits/app/icons.jsx`)
  converts each into an inline `<svg>` that inherits color. **When building new
  Oxagen artifacts, use Lucide** — do not hand-draw icons or use emoji.
- **Typed node dots.** Knowledge-graph entities are coded by a small **color
  dot** (cyan=user, violet=document, green=service, rose=policy, amber=resource)
  — see `NodeChip` and the graph legend, not icons.
- **Brand mark.** The **logomark** is a simple **thick circle outline** (the "O")
  stroked in the **nebula gradient** (cyan→violet→cosmos). The **wordmark** is
  "Oxagen" in **Aeonik Fono** — the only place Fono is used. Lockups combine them
  (horizontal / vertical); mono light/dark tones exist for single-color contexts.
  Component: `OxagenLogo`. Ready-made exports in `brand_assets/`.
- **No emoji, ever.** No unicode-glyph icons.

> **Type rule (important).** Aeonik **sans** is the system face for *everything*
> — headings, UI, body. Aeonik **Fono** is reserved for the `Oxagen` wordmark.
> Aeonik **Mono** appears only for source code, identifiers (node ids, tokens),
> kbd and debug/metric-timing context.

### Assets (`assets/`)
- `oxagen-app-icon.svg` — the logomark: thick nebula-gradient ring (cyan→violet→cosmos).
- `oxagen-icon-gradient.svg` — full app icon: nebula ring on a deep-space bloom background.
- `oxagen-icon-512.png`, `oxagen-icon-192.png` — raster app icons (same ring).
- `fonts/` — Aeonik variable woff2 (sans + italic, Fono, Mono). **Licensed —
  see `uploads/README.md`; do not redistribute the binaries.**

---

## Index / manifest

| Path | What |
|---|---|
| `styles.css` | Global entrypoint — `@import` manifest only. Link this one file. |
| `tokens/colors.css` | Jewel brand ramps, neutrals, semantic, gradients; dark `:root` + `.light`. |
| `tokens/typography.css` | Font families, type scale, weights, tracking. |
| `tokens/spacing.css` | Spacing grid, radii, shadows, glows, motion. |
| `tokens/fonts.css` | Aeonik `@font-face` (self-hosted). |
| `tokens/base.css` | Element defaults + brand utilities (`.ox-eyebrow`, `.ox-gradient-text`, `.ox-gradient-ring`, `.ox-brand-tile`, `.ox-mesh`, `.ox-grid-dots`). |
| `guidelines/*.card.html` | Foundation specimen cards (Colors · Type · Spacing · Brand). |
| `components/core/` | `Button`, `Badge`, `Input`, `Textarea`, `Card`, `Switch`, `Tabs`, `Avatar`. |
| `components/brand/` | `OxagenLogo`, `NodeChip`, `ConfidenceBar`. |
| `components/feedback/` | `Dialog`, `Drawer`, `ToastProvider` + `useToast`. |
| `components/layout/` | `Panel`, `Collapse`, `Sidebar`, `MainNav`. |
| `components/flows/` | `Stepper`, `OnboardingWizard`. |
| `components/code/` | `CodeBlock`, `CodeTabs`, `LangIcon`. |
| `components/lib/motion.js` | framer-motion bridge (progressive enhancement). |
| `ui_kits/app/` | Click-through Oxagen app: Login → Ask (chat) · Knowledge (graph) · Access (RBAC). Dark/light toggle. |
| `brand_assets/` | Export-ready: touch icon, social avatar, OG (light/dark), PWA splash, LinkedIn (light/dark), X banner, 6 Google Ads. |
| `assets/` | Logos, app icons, Aeonik fonts. |
| `DESIGN.md` | Machine-readable agent guide (load order, tokens, component API, rules). |
| `SKILL.md` | Agent-Skills entrypoint (for use in Claude Code). |

**Motion.** Components are motion-enhanced via **framer-motion** (loaded as the
`window.Motion` UMD global, *before* `_ds_bundle.js`). It's optional: without it
components render statically; with it, buttons spring-bounce, tabs slide,
dialogs/drawers/toasts/collapses animate, and the wizard transitions steps.

**Components are consumed** via the compiled bundle:
`const { Button, Card, NodeChip } = window.OxagenDesignSystem_2dfe15` after
loading `_ds_bundle.js` (generated automatically — do not edit by hand).

### Themes
`:root` is the **dark** ("deep space") theme. Add `class="light"` to a wrapper
(or `<html>`) for the **light** theme. All components read the semantic surface
aliases, so they adapt automatically.
