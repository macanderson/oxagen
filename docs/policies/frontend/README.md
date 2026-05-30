# Oxagen Design System

A design system for **Oxagen** — the context layer for AI agents.

Oxagen replaces the bolted-on vector stores and brittle prompt-stuffing most agent stacks rely on with a queryable ontology: a persistent knowledge graph (Neo4J) exposed to any agent over MCP, giving agents a durable mind across sessions, runs, and tools.

The live product pitches a broader consumer angle too — a single intelligent knowledge graph over your email, calendar, bank accounts, photos, and files, with AI agents that automate expense reports, surface subscription waste, track goals, and generate shareable artifacts.

- **Live:** oxagen.ai
- **API:** api.oxagen.ai
- **Docs:** oxagen.ai/developers
- **Company:** Oxagen Inc., San Francisco

## Sources

This design system was built from:

- **Codebase:** `oxagenai/oxagen-platform` (private). Key references:
  - `packages/ui/src/styles/globals.css` — the canonical theme (Tailwind v4 `@theme`)
  - `packages/ui/src/styles/fonts/` — Aeonik variable fonts (sans, fono, mono)
  - `packages/ui/src/components/` — 96 shadcn-based components
  - `services/website/app/` — Next.js 16 marketing site (hero, ontology-visual, agents-visual, etc.)
  - `services/website/components/site-header.tsx`, `site-footer.tsx`
- **Uploaded logo pack** (in `uploads/`, copied into `assets/`): icon + wordmark in gradient, adaptive, mono-light, mono-dark.
- **README/CLAUDE.md** of the platform repo for product context.

## Products represented

The `oxagen-platform` monorepo covers multiple surfaces; this system focuses on the two the user-facing surfaces:

1. **Marketing website** (`services/website`, Next.js 16 + Tailwind v4) — `oxagen.ai`
2. **Platform app** (`services/app`) — the authenticated product (dashboards, ontology, agents, connections)

Supporting surfaces (admin dashboard, API, docs) share the same theme but are out of scope here.

## Index

Root folder manifest:

- `README.md` — this file
- `SKILL.md` — agent-SKILL-compatible entrypoint for Claude Code users
- `colors_and_type.css` — canonical CSS variables (brand + semantic, light + dark)
- `assets/` — logo + icon pack (gradient, adaptive, mono)
- `fonts/` — Aeonik variable fonts (sans, fono, mono)
- `preview/` — small HTML cards that populate the Design System tab
- `ui_kits/` — high-fidelity recreations of Oxagen surfaces
  - `ui_kits/website/` — marketing site components + index
  - `ui_kits/app/` — platform app components + index

---

## Content Fundamentals

### Tone

Technical, confident, calm. The product speaks to developers building agents and to sophisticated consumers — copy assumes intelligence without being academic.

- **Voice:** declarative, present-tense, slightly product-engineer-ish. "We replace all of it with a queryable ontology." "Connect a workspace and your agent gains a durable mind."
- **Point of view:** mostly third-person product-facing ("Oxagen connects your email…"), dropping into second person when addressing the developer/user directly ("Connect an Oxagen workspace to your agent and it gains…").
- **No hype words.** No "revolutionary", "unleash", "supercharge". The product's power is stated, not oversold. Exception: occasional bold adjective like *durable* or *queryable* used precisely.
- **Technical, not jargon-y.** "Ontology", "provenance", "MCP", "knowledge graph" appear without apology — the audience knows them. Abstractions are named, not described.

### Casing

- **Headlines**: Sentence case, not Title Case. "The context layer for AI agents" — not "The Context Layer For AI Agents".
- **UI labels / nav**: Sentence case. "Pricing", "Developers", "Whitepapers".
- **Buttons**: Sentence case, no ending punctuation. "Get started", "Book a demo", "Read the docs".
- **Eyebrows / section labels**: UPPERCASE, heavily tracked (letter-spacing ~0.18–0.2em), mono font.
- **Product name**: `Oxagen`. Never `OXAGEN`, never `oxagen`, never `OxaGen`.

### Emoji

**No.** The brand does not use emoji in product UI, marketing copy, or component libraries. The codebase uses `lucide-react` and bespoke `connector-icons` SVGs instead of emoji. Avoid all emoji.

### Pronouns

- "We" when speaking as the company ("We replace all of it…").
- "You" / "your" when addressing the reader ("Connect your agent…").
- Never "I".

### Specific examples from the product

- Hero: "The context layer for AI agents." / "A queryable ontology that persists across sessions, runs, and tools."
- CTAs: "Get started", "Book a demo", "Join the beta"
- Section eyebrows: `ONTOLOGY`, `CONNECTIONS`, `AGENTS`, `SECURITY`
- Status copy: "9 of 10 tools" / "Event-driven" / "Done" — terse, factual
- Product tagline (from repo): "Oxagen removes the human integration layer between siloed applications by providing ontology as a service."

### Vibe

Think: **Linear meets Vercel meets Stripe docs.** Engineered. Precise. Quietly confident. No exclamation marks. Leave whitespace. Let the gradient ring do the emotional work.

---

## Visual Foundations

### Colors

Two canvases:

- **Dark (`#15151f` / `--oxagen-bg-dark`)** — the hero experience. Near-black ink blue, *never* pure black. Always layered with the brand gradient bloom.
- **Light (`oklch(0.97 0.005 220)` ≈ `#f3f5f8`)** — soft cool white for content pages, docs, app surfaces.

Primary ink: `--oxagen-ink-light #0f131c` on light, `--oxagen-ink-dark #f3f4f7` on dark.

The brand palette leans **cool** — teal (`#1fd0b5`), cyan (`#10a7da`), blue (`#343adc`), indigo (`#562cf0`), violet (`#a269ff`) — with **green** (`#28c36b`) as the one warm accent. The logo's signature gradient runs **indigo (`#7182ff`) → bright green (`#3cff52`)**, left-to-right — this is the canonical brand mark treatment.

A secondary "brand-alt" gradient (`#3b4fe6 → #be1af0`) exists for high-energy marketing moments.

### Type

- **Aeonik** — sans-serif, variable-weight (100–900), for body & UI.
- **Aeonik-Fono** — the display cut; used for **all h1-h6**. Slightly wider, more characterful numerals. This is what gives Oxagen's headlines their look.
- **Aeonik-Mono** — mono for code, eyebrows, metric labels.
- Body: 18–20px, weight 400, line-height 1.6. Headings: weight 500, line-height 1.05–1.25, tracking −0.02 to −0.035em (tight).

### Backgrounds

The signature move is the **`.oxagen-bg`** — a multi-stop radial-gradient composition: emerald top-left, deep indigo top-right, vivid blue bottom-center, with soft hazes at 18%/72% and 82%/50%, layered over a cool base wash. In light mode it reads as soft atmospheric color; in dark mode it becomes deep and moody.

No hand-drawn illustrations. No photography in the marketing hero — instead, *abstract generative visualizations* of the ontology (see `agents-visual.tsx`, `ontology-visual.tsx`, `connections-visual.tsx`, `finance-visual.tsx`, `security-visual.tsx`). These are built with React + Framer Motion, not static imagery.

No repeating patterns. Optional subtle grid overlay on dark sections. No film grain.

### Animation

- **Easing:** `cubic-bezier(0.22, 1, 0.36, 1)` for hover/focus, `cubic-bezier(0.16, 1, 0.3, 1)` for entry (fade-in-up).
- **Entry:** `translateY(20px) opacity(0)` → rest, over `800ms`.
- **Durations:** `160ms` micro, `220ms` base, `400ms` glass hover, `800ms` entry.
- **Motion lib:** Framer Motion. Orchestrated, not decorative.
- Dominant motion is **rise on hover** — buttons `translateY(-2px)` with a shadow grow. Not scale-heavy.

### Hover states

- **Buttons:** `translateY(-0.5)` + `shadow-lg (0 18px 45px rgba(15,23,42,0.18))`. On press, return to `translateY(0)` + `shadow-sm`.
- **Links/ghosts:** background fades in (`hover:bg-muted`). Text never color-shifts aggressively.
- **Glass cards:** background opacity lifts (`0.55 → 0.65`), accent-colored outer glow ring, `translateY(-1px)`.
- **Focus:** `3px ring at 50% opacity` of `--ring` (teal). Always visible; never `outline: none` without replacement.

### Borders & shadows

- **Borders:** 1px, semi-transparent. Light: `oklch(0.88 0.01 220 / 0.85)`. Dark: `oklch(0.34 0.015 260 / 0.75)`. Glass always has a 1px white/10% top-inner highlight.
- **Shadows:** Low-contrast, offset heavy. No hard drop shadows. Brand accent glows (teal/cyan, 12% alpha, 64px blur) on focused/interactive surfaces.

### Radii

- **`--radius` base: 12px** (`0.75rem`).
- Scale: `xs 8 / sm 10 / md 12 / lg 14 / xl 16 / 2xl 20 / 3xl 40`.
- **Large section wrappers: `2.5rem` (40px)** — the signature "chunky pill" container radius.
- Internal cards: 16–24px. Buttons: fully pill (`rounded-full`). Avatars & brand icon: circular.

### Cards

White / near-opaque background (`oklch(0.995 0.002 220 / 0.96)` light) — **cards do NOT default to glass**. Glass is an explicit opt-in via `.glass`. Cards sit on the background with a thin border and `shadow-sm`. Hover lifts shadow subtly.

### Transparency & blur

Used deliberately, in three cases only:

1. **Navigation** — floating glass navbar, `blur(20px)`, 50%-ish opacity.
2. **Overlays** — modals / popovers have `opaque` backgrounds to prevent bleed-through.
3. **Hero chrome** — floating metric chips, prompt bars, sidebar panels.

### Layout rules

- Max width `1600px` (hero), `1200px` (content), `960px` (dense text/docs).
- 12-column or asymmetric 2-col (sticky left, scrollable right).
- Navigation floats; footer is full-bleed dark.
- Hit targets minimum `32px` in dense UI, `44px` on marketing CTAs.

### Imagery

Cool-leaning, dark-biased, *no people*. Product imagery is always synthetic: gradient blooms, graph visualizations, animated SVG, mock product windows tilted 3°. If an image is needed, reach for an abstract visualization *before* a photo.

---

## Iconography

### Primary icon system

[**Lucide React**](https://lucide.dev) — the codebase standard. Available via CDN (`https://unpkg.com/lucide@latest`) or React package. Use Lucide for every generic UI icon (chevrons, search, settings, check, arrow-right, etc.).

- **Weight:** default stroke `1.5–2px`
- **Size:** `16px` (inline), `20px` (nav/ui), `24px` (section headers)
- **Color:** always `currentColor` — icons inherit text color

### Bespoke icon set: connector logos

The repo has a carefully-crafted `packages/ui/src/components/connector-icons.tsx` (15KB) with real brand SVGs for every integration (Google, Plaid, Gmail, Drive, Calendar, Photos, Slack, GitHub, Linear, Notion, Zoom, Stripe, Twilio). **Always use these, never re-draw them.** When unavailable in this design system (we haven't copied them wholesale), reach for official brand kits or substitute `simpleicons.org` via CDN.

### Logos

The Oxagen mark itself is in `assets/`:

- `oxagen-icon-gradient.svg` — ring with indigo→green gradient — **primary brand mark**
- `oxagen-icon-adaptive.svg` — adapts to light/dark context
- `oxagen-icon-mono-light.svg` / `-mono-dark.svg` — single-color for constrained surfaces
- `oxagen-logo-*` — horizontal wordmark variants

The icon is a **broken ring** (a C-shape / open circle) filled with the brand gradient. Never alter the gradient direction, never crush to a solid color (use the mono files instead), never add drop shadows to the ring.

### Emoji

**Never.** Not in product, not in marketing, not in slides.

### Unicode / ASCII chars

Avoid as decorative elements. Exception: `→` `↗` as arrow glyphs in inline CTAs ("Learn more →"), and `·` (middle dot) as a neutral separator in meta lines (`Pricing · Docs · Blog`).

### Substitution flag

This design system does **not** bundle the full Lucide icon set or the `connector-icons` SVGs. For high-fidelity mockups we load Lucide from CDN and note any connector-icon usage as "TODO: import from packages/ui/src/components/connector-icons.tsx".

---

## Notes & Caveats

- **No Figma file** was provided; the system is derived entirely from the codebase + logo pack + brand description.
- The brand description in the kickoff mentioned `Inter` and `#34D399 emerald` — the *actual* codebase uses `Aeonik` variable fonts and a richer teal/indigo/violet palette. We followed the codebase (source of truth) and note the discrepancy here.
- The full `connector-icons.tsx` and many platform-app screens (dashboard, ontology explorer, credits, agent detail) were scoped out for a tractable first pass — flag them to request coverage.
