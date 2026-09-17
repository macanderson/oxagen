## Building with the Oxagen house system

This is the real `@oxagen/ui` library (Base UI + Tailwind v4, token-driven). It is
the house system for both **oxagen** and **stella** — one palette, one type scale;
the logo is the only difference.

### The rule that will bite you

**`styles.css` is a COMPILED, CLOSED stylesheet — there is no Tailwind runtime here.**
Only the ~597 utility classes the library itself already uses exist. A class you
invent (`bg-sidebar-bg`, `p-12`, `gap-8`) silently does nothing — no error, just
unstyled output.

So: **use library components for UI, and CSS variables for your own layout glue.**

```jsx
<div style={{ background: "var(--card)", color: "var(--card-foreground)",
              border: "1px solid var(--border)", borderRadius: "var(--ui-radius)",
              padding: 24, display: "flex", gap: 16 }}>
```

260 semantic tokens are declared at root scope in `_ds_bundle.css` and **always**
resolve (85 of them are redefined under `.dark`). Each one carries a
`/* @kind color|spacing|radius|shadow|font|other */` marker right after its
declaration — if a custom property has no marker it is Tailwind engine plumbing
(`--tw-*`, utility-scoped), not a token to design with. Families (each `--x` plus often
`--x-foreground`):

- Surfaces: `--background` `--foreground` `--card` `--popover` `--muted` `--surface` `--border` `--ring` `--radius` `--ui-radius`
- Brand/state: `--primary` `--brand` `--destructive` `--success` `--warning` `--error` `--info`
- Per-part: `--button-primary-bg` `--input-border-focus` `--menu-item-highlighted-bg`
  `--dialog-bg` `--tab-fg-active` `--tooltip-bg` `--sidebar-nav-link-active-bg`
  `--card-header-bg` `--control-thumb` `--app-topbar-bg` `--badge-bg` `--link`
- Raw house palette (rarely needed directly): `--ox-gold` `--ox-ink` `--ox-paper` `--ox-panel`

Utility classes that DO exist, if you prefer them: `bg-background` `bg-card`
`bg-muted` `bg-primary` `bg-destructive` `text-foreground` `text-muted-foreground`
`text-primary` `border-border` `border-input` `rounded-sm|md|lg|xl|full`
`shadow-sm|md|lg` `font-sans|display|mono|medium|semibold` `text-xs|sm|lg|xl|2xl`
`gap-1|2|3|4|6`. Anything outside that list: use `var(--token)` instead.

### Theme

`:root` is light; `.dark` on an ancestor flips all 85 themed tokens. Set it with
`<ThemeProvider>` (exported) or put `className="dark"` on a wrapper. Components read
tokens through CSS, so nothing else is needed — never hand-pick a hex.

### Type and the gold rule

Space Grotesk is the only family: **400 body · 500 UI · 600 headings and the wordmark ·
700 the Ox lettermark** (`--font-sans` / `--font-display`; `--font-mono` is the system
mono stack, for code and identifiers only — there is no Space Grotesk Mono).

**Gold (`--ox-gold` / `--primary`) is identity, not state: at most one gold action per
screen, and it never encodes success/failure.** State colors are `--success`
`--warning` `--error` `--info` `--destructive`.

### Where the truth lives

- `_ds_bundle.css` — every token, in the `:root` and `.dark` blocks. Read it before styling.
- `guidelines/THEME.md` — the full three-layer token reference (value → mapping → component).
- `components/<group>/<Name>/<Name>.prompt.md` and `<Name>.d.ts` — per-component API and examples.

### Idiomatic example

```jsx
const { Panel, Button, Badge } = window.OxagenUI;

<Panel style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <h2 style={{ font: "600 18px/1.12 var(--font-display)", margin: 0 }}>Fleet</h2>
    <Badge variant="secondary">12 agents</Badge>
  </div>
  <p style={{ color: "var(--muted-foreground)", margin: 0 }}>
    Every run is governed and evidenced.
  </p>
  <Button variant="primary">Register agent</Button>
</Panel>
```
