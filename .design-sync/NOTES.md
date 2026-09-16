# design-sync notes — @oxagen/ui → Claude Design

Project: **Oxagen House Design System** (`f3a06086-f960-4be5-a06c-e5cdd416ade7`)

This design system is the authority for, and should stay consistent with:
`oxagenai/oxagen-brand`, `macanderson/oxagen` (`apps/app`, `apps/web`, `apps/docs`,
`packages/ui`), `macanderson/tmp-oxagen-mockups` (`site/`, `mockups/`) and
`macanderson/stella` (`website/`). Only `packages/ui` is a real component library;
the rest are consumers.

## Build setup

- **[GENERAL] `@oxagen/ui` has no build step and ships no `.d.ts`.** `exports["."]`
  points at `src/index.ts`; apps consume raw TS via `transpilePackages`. The converter
  reads a package's export surface from its `.d.ts` tree, so with none it found
  0 exports and emitted **0 components** (`[TITLE_UNMAPPED]` for all 33 was the
  downstream symptom, not the cause).
  **Fix:** emit declarations before every build:
  ```sh
  ./node_modules/.bin/tsc -p .design-sync/tsconfig.types.json
  ```
  It writes `packages/ui/dist/types/` (43 files) from a sync-local tsconfig, plus a
  one-line `packages/ui/index.d.ts` re-export so `projectFor()` finds the entry
  (it resolves `pkgJson.types || "index.d.ts"`, and adding a `types` field to the
  package was deliberately avoided). Export surface goes 0 → 124 symbols.
  **Both paths are gitignored and `packages/ui`'s own tracked files are untouched** —
  its `tsconfig.json` explicitly says "do not reintroduce `outDir` or `rootDir`",
  so the sync must never add a real build to that package.
- **A full `package-build.mjs` run takes ~9 minutes** (per-component `.d.ts`
  extraction dominates). Batch every config edit into one cycle; use
  `preview-rebuild.mjs --components <Name>` (seconds) for preview iteration and
  `--skip-dts` for non-final loops.
- `titleMap` is required for two components whose story title ≠ export name:
  `Marks` → `OxagenWordmark`, `Toast` → `ToastProvider`.
- **[GENERAL] The `.storybook/preview.tsx` decorator cannot be bundled.** It imports
  `globals.css`, which `@import`s `fonts/space-grotesk.css` with `url(*.woff2)`, and
  the decorator esbuild pass has a hardcoded loader map (`.js`, `.json`) with no
  config hook → `! preview decorator bundle failed: No loader is configured for
  ".woff2"`. **Fix:** `cfg.provider = ThemeProvider` with `initialTheme/defaultTheme:
  "light"`. That is a faithful distillation: the decorator's only other contribution
  was `bg-background p-6 text-foreground`, and `_ds_bundle.css` already carries
  `body{background-color:var(--background);color:var(--foreground)}` from the base
  layer — so only the `p-6` padding is lost, which is framing the grading rubric
  ignores. `ThemeProvider` is browser-safe here (cookie read on mount, matchMedia,
  BroadcastChannel) and pins light deterministically.
- **`[CSS_FROM_STORYBOOK]` is expected and correct.** `globals.css` is a Tailwind v4
  *source* (`@import "tailwindcss"`), not compiled CSS, so there is no `cssEntry` to
  point at. The converter scrapes the compiled CSS out of `sb-reference` — the
  documented catch-all. Do not set `cfg.cssEntry`.
- **`tokens/` is empty on purpose.** `copyTokens()` returns early unless `cfg.tokensPkg`
  is set (tokens must live in a *separate package*); ours live inside `globals.css`.
  They still reach designs — validate reports 316 tokens defined / 211 referenced in
  `_ds_bundle.css`. `cfg.tokensGlob` is inert without `tokensPkg` (and takes a string,
  not an array) — don't re-add it.

## Known warnings — triaged, do not re-chase

- **`[RENDER_THIN] OxagenWordmark`** — false positive. The marks are SVG outlines,
  not text nodes, so the validator's text probe finds nothing while the component
  paints correctly (verified against storybook: both stories `match`). It will read
  thin forever.
- **`[CSS_ASSETS]` 1 relative `url()`** — the woff2 ref; fonts are copied separately
  via `extractFonts` (4 `@font-face` rules → `fonts/`), so this is already handled.

## Upstream defect — NOT caused by the sync

**All four Space Grotesk weights are the same file.**
`packages/ui/src/styles/fonts/space-grotesk-latin-{400,500,600,700}.woff2` are
byte-identical (all `a0d054c4af557de2…`), and so are their sources in
`oxagen-brand/fonts/`. `tools/scripts/sync-brand-assets.mjs` copies them faithfully,
so the defect is in the brand kit, not the sync.

Effect: every `@font-face` rule resolves to the 400 file, so headings (600), UI text
(500) and the Ox lettermark (700) all render with 400 outlines — **in the shipped apps,
not just here**. The wordmarks are exempt because they are SVG paths.

It does not invalidate any grade: both the storybook reference and the previews load
the same file, and the synced DS faithfully reproduces what the product renders today.
`oxagen-brand/fonts/SpaceGrotesk-VariableFont_wght.ttf` is present, so correct statics
can be instanced from it (needs `fonttools` + `brotli`, not installed here).
Fixing it means regenerating brand binaries — a maintainer decision, deliberately not
taken during this sync.

## Verification findings (wave 1)

- **[GENERAL] No owned previews were needed anywhere.** The generated wrappers in
  `.design-sync/.cache/previews/` mirror the stories correctly, including story-local
  `React.useState` closures and provider mounts (`TooltipProvider` nests cleanly inside
  `cfg.provider`'s `ThemeProvider`). `.design-sync/previews/` is empty by design — if a
  future run thinks it needs an owned `.tsx`, re-check the decision tree first.
- **[GENERAL] No `[PORTAL?]` fired for any Base UI overlay** (Select, Combobox, Menu,
  Popover, Tooltip, Dialog) and `.cache/compare/<Name>.json` reports `"portal": false`
  for each — because **nothing ever opens**. Overlays open on interaction and the capture
  harness never interacts, so every overlay story renders the closed trigger on both
  panels. **No `cardMode: "single"` overrides are needed.** Grading these as `match` is
  correct *for the trigger*; see Re-sync risks for what that leaves unverified.
- **The cream-vs-white panel background is preview-card chrome, not a defect.** It becomes
  visible inside a component's own pixels whenever the component has a transparent or
  translucent surface (`Textarea` is `bg-transparent`; `Skeleton` is `bg-primary/10`).
  Still a match — geometry, radius, and settled animation frames are identical.
- Stabilized capture (animations fast-forwarded, reduced motion, frozen clock) settles
  animated components identically on both panels — `Spinner` and `Skeleton` graded this way.
- `CopyButton`'s "Outline With Label" story is icon-only in storybook too — the label is
  the accessible name, not visible text. Not a preview defect.

- **[GENERAL] Escaped `position:absolute` children land in DIFFERENT places on the two
  panels — and it is never a preview-props bug.** The preview host page
  (`components/<group>/<Name>/<Name>.html`) styles `.ds-cell` and `.ds-single` with
  `transform:translateZ(0)`, and a transform establishes a containing block for
  absolutely-positioned descendants; storybook's `#storybook-root` does not. So the same
  escaped element is trapped inside the story box on the preview panel and flies to the
  page corner on the storybook panel. When a stray bar/dot/pill appears in a different
  corner on each side, look for a missing `relative` on the intended parent in the DS
  component — do **not** touch the preview, and note that **no `cfg.overrides` value
  changes this** (the `?story=` capture path always mounts into `.ds-single`, and both
  `cardMode` values keep the transform). Found via `Tabs/Underline`; the rest of
  `packages/ui` was swept and **Tabs is the only current instance** (`slider.tsx` and
  `search-input.tsx` correctly carry `relative`; `segmented-control.tsx` has no absolute
  children).
- **[GENERAL] Simultaneous-contrast trap when eyeballing sheets.** A surface whose token
  fill EQUALS the storybook canvas cream (242,238,229) looks "lighter than the page" on the
  cream panel and "darker than the page" on the white preview panel — the same pixels read
  as two different colors. Hit on `SearchInput` (field fill), `SegmentedControl` (track) and
  `Slider` (unfilled track); all three were byte-identical on both panels. **Sample the
  pixels before calling it a delta.** The same effect moves the visible ink bbox, which makes
  a component look resized (Slider's storybook ink bbox is 136×17 vs the preview's 256×17,
  purely because the cream track is invisible against the cream canvas) — bbox width alone
  is not evidence of a geometry difference.

## Upstream design-system inconsistency (not a sync defect)

**`Tabs` underline indicator escapes its list — the one `close` grade in the sync.**
`tabsListVariants` (`src/components/tabs.tsx`, base string) has no `relative`, so
`TabsIndicator`'s `absolute bottom-0 [left:var(--active-tab-left)]` resolves against
whatever ancestor happens to establish a containing block. The underline therefore lands
somewhere arbitrary — differently per host — **in the product, not just in previews**.
Fix is one word: add `relative` to the `tabsListVariants` base. Graded `close` rather than
"fixed in a preview" deliberately: masking it in an owned `.tsx` would hide the very defect
the storybook oracle exists to catch. Re-grade `Tabs` after the fix lands.

**`Textarea` is the only form control still on pre-token classes.** It uses
`bg-transparent border-input text-muted-foreground` (`src/components/textarea.tsx:7`)
while `Input` uses the full input token family (`bg-input-bg border-input-border
text-input-placeholder`, `input.tsx:15`). Both panels render it identically so no grade
moves, but on any non-cream surface a `Textarea` shows no fill while an `Input` beside it
is filled. A maintainer decision for `packages/ui`, not a preview fix.

## Re-sync risks — what to watch

- **The `.d.ts` emit is a prerequisite, not an artifact.** `packages/ui/dist/types/`
  and `packages/ui/index.d.ts` are gitignored, so a fresh clone has neither and the
  build silently degrades to **0 components**. Always run the `tsc` line above first.
  If a re-sync reports far fewer components than 33, this is why.
- **`cfg.provider` replaced the decorators as the preview wrapper.** If `ThemeProvider`'s
  props change upstream (`initialTheme`, `defaultTheme`, `disableTransitionOnChange`),
  previews lose their theme pin — re-grade a themed component after any change to
  `theme-provider.tsx`.
- **Every overlay's open surface is unverified.** Dialog, Select, Combobox, Menu, Popover,
  Tooltip (and Sheet/Toast) all render only their closed trigger in both panels, so the
  popup, list, bubble and sheet bodies have never been compared against the reference.
  This is the largest verification gap in the sync: the design agent WILL build UIs that
  open these. Do not read their `match` grades as "the whole component is verified" —
  they cover the trigger only. Unverified surfaces: Select's popup/group/items, Combobox's
  search field + item list, Menu's group label/items/shortcuts/separator, Popover's
  title/description/Label+Input row, Tooltip's bubble, Dialog's panel, Sheet's
  `SheetPopup`/header/body/footer, and Toast's toast surface + `ToastViewport` placement.
  **The cheapest real fix is upstream, not in this sync: add a `defaultOpen` story to each
  overlay in `packages/ui/src/components/*.stories.tsx`.** Then both panels render the open
  surface and it verifies like anything else (expect `[PORTAL?]` to start firing at that
  point, which is when `cardMode: "single"` becomes the right override). An owned preview
  that mounts the open state is the fallback if upstream stories can't change — weaker,
  because it renders something the storybook oracle doesn't.
- **Storybook reference and bundle must be rebuilt together.** If `packages/ui/src`
  changes, rebuild `.design-sync/sb-reference` too or every grade compares against the
  old design (`[REFERENCE_STALE?]`).
- Font weights: if the brand kit is ever fixed, all four woff2 hashes change, the
  storybook emits 4 assets instead of 1, and **every component re-renders** — expect a
  styling re-ship and re-verify typography deliberately.
