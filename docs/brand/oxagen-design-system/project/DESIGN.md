# DESIGN.md — Oxagen Design System (agent guide)

A machine-readable operating guide for AI agents building Oxagen-branded
interfaces and assets. Read this first; it tells you what to load, the rules that
must hold, and the exact component API. For brand prose see `readme.md`.

---

## 0. TL;DR contract

1. Link the global stylesheet: `styles.css` (it `@import`s tokens + fonts + base).
2. `:root` = **dark** theme (default). Add `class="light"` on a wrapper for the **light** theme.
3. Load React 18 UMD → (framer-motion UMD) → `_ds_bundle.js`, **in that order**.
4. Read components from `window.OxagenDesignSystem_2dfe15`.
5. **Type rule:** Aeonik (sans) for everything. Aeonik **Fono only** in the
   `Oxagen` wordmark. Aeonik **Mono only** for source code, identifiers (node
   ids, tokens), kbd, and debug/metric-timing context.
6. **No emoji.** Icons are **Lucide** (thin stroke, `currentColor`).
7. One gradient moment per surface; everything else flat neutral.

---

## 1. Loading the system

### Static HTML / prototypes
```html
<link rel="stylesheet" href="PATH/styles.css">
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<!-- framer-motion is OPTIONAL but enables all motion. Load it BEFORE the bundle. -->
<script src="https://cdn.jsdelivr.net/npm/framer-motion@11.18.2/dist/framer-motion.js"></script>
<!-- Lucide for icons -->
<script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>
<script src="PATH/_ds_bundle.js"></script>
<script type="text/babel">
  const { Button, Card, Tabs, OxagenLogo } = window.OxagenDesignSystem_2dfe15;
</script>
```
Motion is **progressively enhanced**: if `window.Motion` (framer-motion) is
absent, components still render — they just don't animate. When present, buttons
bounce, tabs slide, dialogs/drawers/toasts/collapses animate.

### Production React
Import tokens via the CSS, then mirror these components (they're plain React +
CSS custom properties, no third-party UI deps). Lift exact values from `tokens/`.

---

## 2. Design tokens (CSS custom properties)

All live under `:root` (dark) and are re-mapped under `.light`. Reference the
**semantic** aliases in product UI, not the raw ramps.

| Concern | Tokens |
|---|---|
| Brand jewels | `--ox-cyan #7CE8F4` · `--ox-violet #7C5AED` · `--ox-cosmos #DF2A5D` · `--ox-indigo #3C1F89` |
| Ramps | `--violet-50…900`, `--cyan-50…900`, `--cosmos-300…700`, `--ink-25…950` |
| Surfaces | `--background` `--background-2` `--card` `--elevated` `--popover` `--sidebar` |
| Text | `--foreground` `--muted-foreground` `--card-foreground` |
| Action | `--primary` `--primary-hover` `--secondary` `--accent` `--brand` `--brand-2`(cyan) `--brand-3`(cosmos) |
| Lines | `--border` `--border-strong` `--input` `--ring` |
| Status | `--info` `--success` `--warning` `--danger` (+ `-foreground`) |
| Gradients | `--grad-nebula` `--grad-aurora` `--grad-cosmos` `--grad-sunset` `--grad-ring` |
| Type | `--font-sans` `--font-display`(Fono) `--font-mono` · `--text-xs…6xl` · `--weight-*` · `--tracking-*` |
| Space | `--space-1…20` (4px grid) · `--radius-sm/md/lg/xl/2xl/full` |
| Elevation | `--shadow-xs…xl` · `--glow-violet` · `--glow-cyan` |
| Motion | `--ease-entry/hover/exit` · `--motion-micro/base/overlay/entry` |

### Brand utility classes (from `tokens/base.css`)
`.ox-eyebrow` (uppercase tracked label, sans) · `.ox-gradient-text` /
`.ox-gradient-text-aurora` · `.ox-gradient-ring` (nebula hairline border) ·
`.ox-glow-violet` / `.ox-glow-cyan` · `.ox-mesh` (radial jewel bloom bg) ·
`.ox-grid-dots` (graph-canvas dot grid) · `.ox-wordmark` (Aeonik Fono).

---

## 3. Component API (`window.OxagenDesignSystem_2dfe15`)

> Props below are the load-bearing ones. Full contracts live in each
> `components/**/<Name>.d.ts`; usage snippets in `<Name>.prompt.md`.

**Core**
- `Button` — `variant` primary|secondary|outline|ghost|destructive|**gradient**|link · `size` sm|md|lg · `iconOnly` · `startIcon`/`endIcon`. Spring bounce on hover/press.
- `Card` (+ `CardHeader` `CardTitle` `CardDescription` `CardBody` `CardFooter`) — `glow`, `gradientRing`, `interactive`.
- `Input` / `Textarea` — `invalid`, `startIcon` (Input). Violet focus glow.
- `Switch` — `checked`/`defaultChecked`, `onChange`.
- `Tabs` — `items:[{value,label,icon?,badge?}]`, `value`/`onChange`. **Sliding** gradient indicator.
- `Avatar` — `src`|`name` (initials on hashed gradient), `size`, `gradient`.

**Brand**
- `OxagenLogo` — `variant` mark|wordmark|horizontal|vertical · `tone` gradient|mono-light|mono-dark|solid · `size`. The mark is a thick nebula-gradient ring; wordmark is Aeonik Fono.
- `NodeChip` — `kind` user|document|service|policy|resource · `id` (mono) · `label?`. A typed knowledge-graph node reference.
- `ConfidenceBar` — `score` 0–1. Threshold-colored edge-confidence meter.

**Feedback** (need framer-motion for animation)
- `Dialog` — `open`/`onClose`, `title`, `description`, `footer`. Centered modal, blurred scrim, Esc-to-close.
- `Drawer` — `open`/`onClose`, `side` right|left|bottom, `title`, `footer`, `size`.
- `ToastProvider` + `useToast()` — wrap app; `push({title,description,tone,icon})`. Tones default|success|warning|danger|cyan.

**Layout / Nav**
- `Panel` — `title`, `eyebrow`, `actions`, `footer`, `inset`. Titled surface block.
- `Collapse` — `title`, `subtitle?`, `icon?`, `defaultOpen`/`open`+`onToggle`. Height-animated disclosure.
- `Sidebar` — `groups:[{label?,items:[{id,label,icon?,badge?}]}]`, `active`/`onSelect`, `header`/`footer`. Sliding gradient accent.
- `MainNav` — `brand`, `items:[{id,label,href?}]`, `active`/`onSelect`, `actions`, `sticky`. Horizontal top nav, sliding underline.

**Flows**
- `Stepper` — `steps:[{label,description?}]`, `current` (0-based).
- `OnboardingWizard` — `steps:[{label,description?,render}]`, `onComplete`, `initialData`. Animated multi-step; each `render` gets `{index,goNext,goBack,data,setData}`.

**Code** (dev-docs)
- `CodeBlock` — `code`, `language`, `filename?`, `showLineNumbers?`, `copy?`. Header glyph + copy button, jewel syntax tint.
- `CodeTabs` — `tabs:[{language,label?,filename?,code}]`. Per-language tabs with glyphs + copy; fade between languages.
- `LangIcon` — `language` (ts/js/py/go/rust/bash/json/sql/cypher/graphql/curl…) or `node`.

---

## 4. Voice & content rules

- Second person to the user; the product is "Oxagen" / "the agent" (never "we").
- **Sentence case** everywhere; mono/sans eyebrows are UPPERCASE + tracked.
- Lead with the security guarantee ("Retrieval is RBAC-enforced"). Plain, exact, no hype, no exclamation points, **no emoji**.
- Entity IDs: mono with typed prefix — `prn_…` (principal), `doc_…`, `svc_…`, `pol_…`, `tok_…`.
- Tagline: **"Secure context for AI agents."** Supporting: "Typed knowledge graph · RBAC-scoped retrieval".

---

## 5. Visual rules (do / don't)

**Do:** dark-first deep-space surfaces; one gradient moment per surface; hairline
1px borders; glow (not heavy shadow) for focus/featured; Lucide icons; typed
color dots for graph entities; `.ox-mesh` on hero/auth, `.ox-grid-dots` behind
graph canvases; restrained fade+rise motion on the product tokens' easings.

**Don't:** use Aeonik Fono anywhere but the wordmark; use mono for body/labels;
use emoji or unicode-glyph icons; stack multiple gradients on one surface;
add bouncing/looping decoration to content; invent new hues outside the ramps;
make colored-left-border cards or glassmorphism panels (surfaces are opaque).

---

## 6. Building new artifacts (recipe)

1. Decide theme: dark (default) or `.light`. Set it on the outermost wrapper.
2. Compose from §3 components; don't re-implement primitives.
3. Icons → Lucide. Logo → `OxagenLogo`. Code → `CodeBlock`/`CodeTabs`.
4. Headlines/body → Aeonik sans; the only Fono is the wordmark.
5. Add at most one gradient focal point (hero CTA, gradient text, or ring).
6. Want motion? Load framer-motion before the bundle — components animate automatically.
7. For full product surfaces, mirror `ui_kits/app/` (Shell + screens) rather than starting from scratch.
8. Brand/marketing exports live in `brand_assets/` (og, social banners, ads, splash, icons) — copy one as a starting point and swap copy.
