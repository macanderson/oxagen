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

## Round 2 (2026-09-16) — upstream fixes landed, re-verified

All three defects below were FIXED in this round; the sections further down record what they
were. The DS source changed, so `sb-reference` and the bundle were rebuilt together and the
affected components re-graded.

- **Fonts corrected.** The four `space-grotesk-latin-*.woff2` are now genuinely 400/500/600/700
  (instanced from `oxagen-brand/fonts/SpaceGrotesk-VariableFont_wght.ttf` with `fontTools`,
  subset to the same 230 codepoints the old file covered). Installed in **both**
  `oxagen-brand/fonts/` and `packages/ui/src/styles/fonts/`. Proof it took: the build's
  `[CSS_ASSETS]` line now names **four** distinct hashed woff2 assets where it named one.
  Regenerate with `uv run --with fonttools --with brotli` + `varLib.instancer` + `pyftsubset`.
- **`Tabs` fixed** — `relative` added to the `tabsListVariants` base, with a comment saying why.
- **Seven `Open` stories added** (Dialog, Select, Menu, Popover, Tooltip, Sheet, Toast) so the
  overlay surfaces are verifiable. Story count 58 → 65. Toast uses `timeout: 0` so the capture
  is deterministic.
- **Two pre-existing typecheck errors cleared** (`alert.stories.tsx`, `textarea.stories.tsx`:
  `render: (args)` implicitly `any`). `tsc --noEmit` now exits 0; 362 unit tests pass.
- **`[GRID_OVERFLOW]` now fires on 7 overlays** — expected and correct: the open stories really
  do portal outside their grid cell. Remedy applied in config: `cardMode: "single"` with
  `primaryStory` pointing at the OPEN story, so each card shows the surface worth seeing.
  Presentation-only, so grades carry and a targeted `preview-rebuild.mjs` is enough.

## Upstream defect — NOT caused by the sync

**[FIXED 2026-09-16 — kept as the record of what was wrong and how to detect it again.]**

**All four Space Grotesk weights were the same file — and that file was Light 300.**
`packages/ui/src/styles/fonts/space-grotesk-latin-{400,500,600,700}.woff2` were
byte-identical (all `a0d054c4af557de2…`), and so were their sources in
`oxagen-brand/fonts/`. `tools/scripts/sync-brand-assets.mjs` copies them faithfully,
so the defect was in the brand kit, not the sync.

The shipped file's own `name` table read **"Space Grotesk Light"** with
`usWeightClass 300`, and its stem width and advances matched the variable font at
`wght=300` exactly — i.e. the vendoring subset the VF at its **axis default** (300) four
times rather than instancing four weights. **Detection recipe if it regresses:**
`shasum -a 256 fonts/space-grotesk-latin-*.woff2` (four identical hashes = broken), and
`TTFont(f)["OS/2"].usWeightClass` / `name.getDebugName(4)` on each file.

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

---

## Token classification — `@kind` markers and the scope rule (2026-09-16)

**The consuming app derives the DS token list from the CSS itself, and its scope
filter is a permissive heuristic** — `css.mjs`'s own comment says it accepts
`:root`/theme containers *and* single lowercase class selectors *and* data-attr
selectors. Under Tailwind v4 that is badly over-inclusive: `--tw-*` internals are
declared in the `*,:before,:after,::backdrop` reset, registered via `@property`,
and set per-utility under `.scale-50`, `.font-medium`,
`:where(.space-y-2>:not(:last-child))` and friends. All of it renders; none of it
is a token anyone should design with.

The converter cannot change the app's scanner, so it makes the CSS state the
contract instead. `.ds-sync/lib/css-tokens.mjs` runs after
`rewriteBundleFontFaces` and before `writeStylesCss`:

- **Scope rule.** A declaration is a design-system token iff its selector list
  contains `:root` (qualifiers allowed — `:root:not(.light):not(.dark)` counts),
  `:host`, `.dark`, or a bare `[data-*]` scope. A descendant combinator
  disqualifies (`:root .btn` scopes to a component). `--tw-*` is excluded
  unconditionally, whatever its scope.
- **Kind.** Every real token gets `/* @kind color|spacing|radius|shadow|font|other */`
  after its declaration, read from `.design-sync/token-kinds.json` (263 entries,
  transcribed from the project's `_adherence.oxlintrc.json` → `x-omelette.tokenKinds`,
  so the stylesheet and the adherence config cannot drift). A token absent from the
  map falls back to value inference and is reported as `[TOKEN_KIND_INFERRED]` —
  that warning is the signal to add it to the map, not to ignore it.
- **Header.** A first-line `/* @ds-tokens: {...} */` comment states the rule
  machine-readably: **annotated means token.** Anything without a `@kind` marker —
  every `--tw-*`, every `@property` registration, every utility-scoped declaration —
  is engine plumbing.

Config key: `cfg.tokenKinds` (path, workspace-bounded; defaults to
`.design-sync/token-kinds.json`). It sits in the **styling** trust class alongside
`cssEntry`/`tokensPkg`/`extraFonts` — deliberately NOT in the grade key, because a
classification comment cannot change a rendered pixel. It does flow into `styleSha`,
so an annotation change correctly re-ships the styling surface.

**Verified:** 445 declarations / 260 distinct tokens annotated, **0 inferred**
(every one resolved from the map); 130 declarations excluded as engine internals.
The pass is lossless (stripping the comments restores the input byte-for-byte),
idempotent, and postcss parses the annotated file to identical structure —
1514 decls / 708 rules / 156 at-rules, before and after.

## Converter defect fixed — `inlinedExternals` said `.pnpm` (2026-09-16)

`lib/bundle.mjs` derived each inlined package name from the **first**
`node_modules/` segment of the esbuild metafile input path. pnpm resolves
everything through a virtual store —
`node_modules/.pnpm/<mangled>/node_modules/<real-pkg>/…` — so the first segment is
always `.pnpm`, and the whole `inlinedExternals` list collapsed to the single
literal `[".pnpm"]`. That field drives the app's keep-vs-rebuild decision and is
the DS's only record of what is baked into the bundle, so it was reporting nothing
usable on every pnpm repo.

Fixed by taking the **last** `node_modules/` segment and never accepting a
dot-prefixed one. Correct under flat npm/yarn, nested yarn, and the pnpm store
alike. Result here: `1` → **16** real package names
(`@base-ui-components/react`, `@floating-ui/*`, `framer-motion`, `lucide-react`,
`clsx`, `class-variance-authority`, `tailwind-merge`, `motion*`,
`use-sync-external-store`, …).

## What the design page actually provides — settles the "externals" question

`support.js` in the uploaded project (the `dc-runtime`, generated, not ours) names
its entire CDN table:

```
react@18.3.1/umd/react.production.min.js
react-dom@18.3.1/umd/react-dom.production.min.js
@babel/standalone@7.29.0/babel.min.js
```

That is the whole set of globals. **There is no Base UI global and no in-browser
module resolver** — Babel standalone transpiles JSX, it cannot resolve a bare
specifier. So externalizing `@base-ui-components/*` would make Select, Menu,
Popover, Dialog, Tooltip, Sheet, Tabs, Checkbox, Switch, Slider, RadioGroup,
SegmentedControl, Combobox and Toast throw at load. **Base UI stays inlined.**
React and react-dom are already externals via `reactShim` → `window.React` /
`window.ReactDOM`; nothing to change there.

**Open defect — React version skew.** The DS is built against React 19.2.6 and
`_vendor/react.js` vendors 19.2.6, but it merges with `||=` no-clobber semantics
(`window.React=window.React||window.__dsReact`). The page loads React 18.3.1 from
unpkg, so on any page where both run the vendored 19 is discarded and a
19-targeted bundle executes on 18. Not changed here: the no-clobber merge exists
so a host page's React is never stomped, and flipping it is a skill-level
decision, not a per-repo one.

## `fonts/` is remote-only — never include it in a writes or deletes plan

The uploaded project's `fonts/` carries **5 DejaVu Sans Mono Nerd Font families
backed by 9 TTFs** plus `space-grotesk-latin-400-DPT1xrvW.woff2`, and its
`fonts.css` registers all of them with local `./` URLs. **None of those TTFs are in
this repo** — `fd` finds them only in `~/Library/Fonts`, and `cfg.extraFonts` is
bounded to `workspaceRoot`, so the converter cannot reproduce them.

A local build therefore emits a 4-rule Space-Grotesk-only `fonts/fonts.css`. Pushing
`fonts/**` would overwrite the good file with the poorer one and the reconciliation
pass would delete all 9 TTFs — silently degrading every mono surface in every design
built with the DS. **Exclude `fonts/**` from both `writes` and `deletes` on every
sync until the binaries live in the repo.** Making it reproducible means committing
the DejaVu TTFs (Bitstream Vera / Arev licence — redistribution is permitted) under
e.g. `packages/ui/src/styles/fonts/` with matching `@font-face` CSS, then pointing
`cfg.extraFonts` at that CSS. That is a maintainer call, not a sync-time one.

Note `styleShaFor` hashes `fonts/`, so local-vs-remote font divergence keeps the
styling surface permanently "changed". Expected while the above holds.

## Harness gap — the compare cache outlives the screenshots it points at

Found the hard way on 2026-09-16 when two sessions shared one `ds-bundle/`.

`.design-sync/.cache/compare/<Name>.json` records `sheet` / `sbShot` / `dsShot`
paths under `ds-bundle/_screenshots/`. A `package-build.mjs` run **cleans
`ds-bundle/`**, so those PNGs vanish while the cache JSON stays fresh and keeps
naming them. A grader handed that cache sees plausible paths to files that do not
exist — phantom artifacts rather than a recapture signal.

There is no way back from inside a grading pass: `compare.mjs` hard-requires
`ds-bundle/.stories-map.json` (`.ds-sync/storybook/compare.mjs:86`), and only
`package-build.mjs` writes it (`.ds-sync/package-build.mjs:842-850`). So any agent
scoped to grading — a fan-out subagent especially — cannot recapture its own
sheets. The correct behaviour is to refuse to grade unseen images and say so.

**Working rule:** never run a grading pass concurrently with, or across, a
rebuild. If `ds-bundle/_screenshots/` is missing while `.cache/compare/*.json`
looks current, the cache is lying — re-run the driver (which rebuilds and
recaptures) rather than trying to grade from it.

**Worth fixing upstream** (neither is a per-repo fix, so neither was done here):
either compare writes sheets outside the bundle's clean scope, or the cache JSON
self-invalidates when a referenced shot is missing so the next run recaptures.

## Round 2 (2026-09-16) — what changed in `packages/ui`, and what it unblocks

A parallel session landed four source changes that this sync is the first to see.
All four were verified here independently before being relied on.

1. **`tabs.tsx` — `relative` added to the `tabsListVariants` base.** This is the
   fix the previous round's one `close` grade asked for; `Tabs` should now grade
   `match` with the underline under the active tab on both panels.
2. **Space Grotesk is real now.** Every one of the four `space-grotesk-latin-*.woff2`
   was the SAME file at HEAD (`a0d054c4…`) and it was **Light 300**, not 400 —
   confirmed here with fontTools: `usWeightClass=300`, 291 glyphs. The vendoring
   had subset the variable font at its axis default four times, so body, UI,
   headings and the lettermark all rendered Light **in the shipped apps**, not just
   in this sync. They are now instanced per weight from the brand kit's VF, and the
   outlines genuinely differ — glyph `H` left side bearing runs 80 / 73 / 69 / 66
   across 400/500/600/700 against the old file's 86. Same 230-codepoint coverage.
   *Residual, cosmetic:* all four still carry the VF's stale `name` ID 4,
   `"Space Grotesk Light"`, and subfamily `"Regular"`. CSS matches on the declared
   `font-family`/`font-weight`, so rendering is correct; only the internal metadata
   is misleading. Worth a `--name` pass next time the fonts are regenerated.
3. **Seven `Open` stories** (Dialog, Select, Menu, Popover, Tooltip, Sheet, Toast)
   using `defaultOpen`; story count 58 → 65. This closes what the previous round
   called the largest verification gap in the sync — every overlay had only ever
   been photographed closed.
4. Two pre-existing typecheck errors fixed (`alert.stories.tsx`,
   `textarea.stories.tsx`: `render: (args)` implicitly `any`).

`cfg.overrides` gained `{cardMode: "single", primaryStory: "Open"}` for the six
portal overlays and `"Right Open"` for Sheet — required, because the open stories
genuinely portal and the grid card overflows without it. Both keys are
presentation-only and deliberately outside the grade contract, so adding them does
not clear grades.

**The `fonts/` rule from the previous section is now a MERGE, not a skip.** Local
Space Grotesk is strictly better than what is uploaded (the live remote
`fonts/fonts.css` points all four SG weights at the single old Light file), while
the DejaVu half of the warning stands unchanged. `cfg.extraFonts` →
`../../.design-sync/fonts-dejavu.css` makes the merge automatic: the build now
emits **13 `@font-face` rules** (4 real SG weights + 9 DejaVu) instead of 4.
`fonts/**` therefore belongs in an upload's **writes** — and still never in its
**deletes**.

**Two path-resolution traps in `cfg.*` fields**, both hit here:
- `extraFonts` resolves against **PKG_DIR**, so a `.design-sync/` sidecar needs the
  `../../` prefix. `.design-sync/fonts-dejavu.css` silently logs
  `not found — skipped` and the build carries on with 4 rules.
- `tokenKinds` (added this round) resolves against the **config home**, like
  `readmeHeader` — the base that is correct in a monorepo. Don't copy `extraFonts`'
  convention onto it.

### Font changes are a THREE-artifact change in this repo

Learned the expensive way on 2026-09-16. Changing a font binary means updating
all three of these, or the fix silently un-fixes itself:

1. **`packages/ui/src/styles/fonts/`** — the source the app and storybook compile.
2. **`.design-sync/sb-reference/`** — rebuild it. `[CSS_FROM_STORYBOOK]` means
   `_ds_bundle.css` *and the font binaries* are scraped out of the storybook build,
   not out of `packages/ui`. Rebuild only the bundle and `ds-bundle/fonts/` is
   repopulated from the stale storybook assets: the upload ships the OLD binaries
   under a build that reports the fix as landed. That is worse than not fixing it,
   because it retires the check. **Gate:** after any font change, diff the
   `sb-reference/assets/*.woff2` hashes against `packages/ui/src/styles/fonts/`
   before relaunching the driver.
3. **`~/Projects/oxagen-brand/fonts/`** — the brand kit is the UPSTREAM.
   `tools/scripts/sync-brand-assets.mjs` copies `BRAND/fonts/*.woff2` →
   `packages/ui/src/styles/fonts/` (line ~301), so a stale kit means the next run
   of that script quietly reverts the package. Leaving the kit behind doesn't just
   split the two repos — it arms a regression.

**Diagnosing a bad weight set:** check `OS/2.usWeightClass` and stem metrics
(glyph `H` left side bearing across 400/500/600/700 — it must decrease
monotonically as weight rises; here 80/73/69/66, against the broken file's 86).
Do **not** test on `name.getDebugName(4)`: names are metadata anyone can set
correctly while shipping the wrong outlines, so the name string is the symptom,
not the test. Related trap — `instantiateVariableFont(updateFontNames=True)` does
not fix the names here, because 600 is not an `fvar` named instance (only
300/400/500/700 are); the records must be set explicitly.

## Grade contract blind spot — a COMPONENT-source fix does not clear a grade

`sourceKeyFor` fingerprints the **story file** (`srcSha`), the owned preview, the
story set and the preview-affecting config. It does **not** see
`packages/ui/src/components/<name>.tsx`. So an upstream fix to a component ships
while its grade carries forward unchanged.

Hit exactly this on 2026-09-16: `Tabs` carried a `close` verdict whose recorded
root cause — "tabsListVariants has no `relative`" — had already been fixed in
`tabs.tsx`. No story file changed, so the driver listed `Tabs` in `upload.components`
but NOT in `pendingGrade`, and the stale verdict would have shipped as the DS's
record of a defect that no longer exists. Forced a recapture
(`compare.mjs --components Tabs --force`) and it regrades `match`: the orange
indicator now sits under the active tab on both panels.

**Rule:** after any fix to a component's own source, force-recapture that component.
`node .ds-sync/storybook/compare.mjs --out ./ds-bundle --storybook-static
.design-sync/sb-reference --components <Name> --force`. (Note `compare.mjs` takes
no `--config`; it warns and ignores it.)

## conventions.md — validation pass, 2026-09-16

Every name still verifies: all 36 real tokens it cites are declared, and all 33
utility classes it lists as existing are present in `_ds_bundle.css`. (`--x` /
`--x-foreground` are the family placeholder, correctly absent; `bg-sidebar-bg`,
`p-12`, `gap-8` are its own examples of classes that do NOT exist and correctly
do not.)

Two asserted counts had drifted. `222 semantic tokens` → corrected to **260**,
which is now exactly the `@kind`-annotated set, so the number and the stylesheet
cannot drift apart again. `85 redefined under .dark` still verifies exactly.

**The utility-class count was stale too, and has been revised to `~597`** (by a
parallel session, mid-run). 325 was certainly wrong. Counting the built CSS gives
701 raw class selectors, or **586** distinct base utilities once variant prefixes
(`hover:`, `dark:`, `group-*`) are folded and harness classes (`ds-*`) dropped —
so `~597` is the right order of magnitude, and its tilde carries real uncertainty
rather than decoration. Nobody has reproduced an exact figure, because "utility
class" has no single definition here: it turns on whether you count variants,
arbitrary-value escapes and `group/name` scopes separately.

If you touch this number again, recompute it and record which method you used, or
drop the numeral entirely. The load-bearing claim does not need it: the utility
set is CLOSED — invent a class and it silently does nothing — and the explicit
class list beneath it is verified correct.
