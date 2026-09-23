# @oxagen/ui

**coss ui** is the shared component system and house token set for Oxagen's
frontends. It is built on **[Base UI](https://base-ui.com/)** (not Radix) and
**Tailwind v4** with a fully token-driven theme.

The package ships **raw TypeScript source** with no build step. The Next apps
consume it through `transpilePackages`, and `apps/desktop` imports its styles
through Vite. `apps/docs` and `apps/app_deprecated` import components through
their local re-export layer (`@/components/ui/<name>`) or the barrel.
`apps/app` has its own components in `apps/app/src/ui/` and takes only the
barrel's brand marks and the styles from here. App code must **never** import
`@oxagen/ui/components/*` directly (see the root `AGENTS.md`, UI Component
Import Convention).

## Boundary

- **Owns:** the shared components, the house design tokens and fonts
  (`src/styles/`), the theme provider and cookie, the motion helpers, `cn`,
  and the Storybook for all of them.
- **Does not own:** `apps/app`'s own components (`apps/app/src/ui/`, see
  [`apps/app/README.md`](../../apps/app/README.md)); the public website's
  stylesheet (`apps/web/assets/oxagen.css`, see
  [`apps/web/README.md`](../../apps/web/README.md)), which mirrors these
  tokens without importing the package; the house brand kit itself
  (`oxagenai/oxagen-brand`, checked by `pnpm check:brand`), from which
  `src/styles/house-tokens.css` is vendored.
- **Depends on:** No `@oxagen/*` runtime dependencies. `react`, `react-dom`,
  and `tailwindcss` are peer dependencies.
- **Used by:** `apps/app`, `apps/docs`, `apps/app_deprecated`, and
  `apps/desktop`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| Barrel (`@oxagen/ui`) | export | `packages/ui/src/index.ts` | `apps/app/src/ui/auth-shell.tsx`, `apps/app/src/features/shell/sidebar.tsx`, `apps/docs`, `apps/app_deprecated` |
| Deep component import (`@oxagen/ui/components/*`) | export | `packages/ui/src/components/*.tsx` | Only the re-export files in `apps/docs/src/components/ui/` and `apps/app_deprecated/src/components/ui/` |
| Direct component import ban | boundary | `eslint.next.mjs` (`no-restricted-imports`) | `apps/docs`, `apps/app_deprecated`. `apps/app` has no such rule |
| Design tokens (`globals.css`, `house-tokens.css`, fonts) | export | `packages/ui/src/styles/` | `apps/app/src/app/globals.css`, `apps/desktop/src/styles.css` |
| `THEME_COOKIE_NAME` | export | `packages/ui/src/components/theme-config.ts` | `apps/app/src/features/shell/theme.ts` reads the same cookie name |

## Entry points

- `.` → `src/index.ts`: the tree-shakeable component barrel, providers, and
  `cn`.
- `./components/*` → `src/components/*.tsx`: one component file, for the
  re-export layers only.
- `./styles/globals.css`, `./styles/house-tokens.css`,
  `./styles/fonts/space-grotesk.css` → the token and font stylesheets.
- `./lib/motion` → `src/lib/motion.ts`: motion helpers.
- `./styles/tokens.css` is declared in `package.json` but no file exists at
  `src/styles/tokens.css`. Do not import it.

## Rules

- Composition uses the `render` prop, never Radix `asChild`.
- Overlay parts are named `*Popup` or `*Panel`, never `*Content`.
- Reskin by editing tokens, not component class strings.
- Add or update a story whenever you add or change a component.

## Tests

```bash
pnpm --filter @oxagen/ui test:unit src/components/button.test.tsx
```

Never put `--` before the filename. Each component's test sits beside it as
`src/components/<name>.test.tsx`. Tests for `apps/app`'s own components live
in `apps/app/src/ui/`, not here.

## Composition

Two rules that catch everyone:

1. **Composition uses the `render` prop, not Radix `asChild`.**
2. **Overlay/content parts are named `*Popup` / `*Panel`, not `*Content`.**

```tsx
// ✅ coss                                  // ❌ shadcn/Radix
<Button render={<Link href="/login" />}>Login</Button>
<DialogPopup>…</DialogPopup>               // not <DialogContent>
```

## Storybook

Storybook runs the components straight from `src` (no build) with Tailwind v4 +
the design tokens processed through `postcss.config.mjs`. A **theme toolbar**
(top bar) flips every story between the light and dark token sets.

```bash
# from the repo root
pnpm --filter @oxagen/ui storybook        # dev server → http://localhost:6008
pnpm --filter @oxagen/ui build-storybook  # static build → storybook-static/

# or from packages/ui
pnpm storybook
```

Stories live next to their component as `src/components/<name>.stories.tsx` and
are grouped in the sidebar by `title`: **Primitives**, **Forms**, **Surfaces**,
**Navigation**, **Overlays**, **Brand**. Add a story whenever you add or change
a component.

## Component inventory

Import from `@oxagen/ui` (barrel) or `@/components/ui/<file>` (app proxy).

### Primitives

| Component | File | Parts / API | Notes |
|-----------|------|-------------|-------|
| Button | `button.tsx` | `Button` (`render`) | variants `primary`/`default`/`secondary`/`outline`/`ghost`/`destructive`/`destructive-outline`/`link`/`gradient`; sizes `xs`/`sm`/`default`/`lg`/`xl`/`icon`/`icon-sm`/`icon-lg`. Compact scale — use `lg` for shadcn `default` (36px). |
| Badge | `badge.tsx` | `Badge` (`render`) | variants incl. semantic `info`/`success`/`warning`/`error`; sizes `sm`/`default`/`lg`. |
| Alert | `alert.tsx` | `Alert`, `AlertTitle`, `AlertDescription` | variants `default`/`info`/`success`/`warning`/`error`. |
| Separator | `separator.tsx` | `Separator` | `orientation` `horizontal`/`vertical`. |
| Skeleton | `skeleton.tsx` | `Skeleton` | loading placeholder. |
| Spinner | `spinner.tsx` | `Spinner` | `size` `xs`…`xl`; `role="status"` with an `sr-only` `label`. |
| StatusDot | `status-dot.tsx` | `StatusDot` | `status` `success`/`warning`/`error`/`info`/`neutral`/`primary`; optional `pulse`, `label`, `srLabel`. |
| Label | `label.tsx` | `Label` | pairs with form controls via `htmlFor`. |

### Forms

| Component | File | Parts / API | Notes |
|-----------|------|-------------|-------|
| Input | `input.tsx` | `Input` | `size` `sm`/`default`/`lg`. |
| Textarea | `textarea.tsx` | `Textarea` | `size` `sm`/`default`/`lg`. |
| Checkbox | `checkbox.tsx` | `Checkbox` | `checked` / `onCheckedChange`; supports indeterminate. |
| Switch | `switch.tsx` | `Switch` | `checked` / `onCheckedChange`. |
| RadioGroup | `radio-group.tsx` | `RadioGroup`, `Radio` | `defaultValue` / `value` on the group. |
| SegmentedControl | `segmented-control.tsx` | `SegmentedControl`, `SegmentedControlItem` | single-select pill; `value` is a **string** (not array). |
| Slider | `slider.tsx` | `Slider` (+ `SliderControl`/`Track`/`Indicator`/`Thumb`/`Value`) | `defaultValue`/`min`/`max`/`step`. |
| Select | `select.tsx` | `Select`, `SelectTrigger`, `SelectValue`, `SelectPopup`, `SelectGroup`, `SelectLabel`, `SelectItem` | SSR: pass `items` to `Select`. ≤20 options. |
| Combobox | `combobox.tsx` | `Combobox`, `ComboboxTrigger`, `ComboboxValue`, `ComboboxPopup`, `ComboboxItem` | searchable typeahead — use for >20 options. Item labels must be plain strings, or search will not match them. |
| SearchInput | `search-input.tsx` | `SearchInput` | `Input` plus a leading glyph and an optional `onClear` button. |

### Surfaces

| Component | File | Parts / API | Notes |
|-----------|------|-------------|-------|
| Card | `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardPanel`, `CardFooter` | body wrapper is `CardPanel`. |
| Panel | `panel.tsx` | `Panel` | titled surface block (`eyebrow`/`title`/`actions`/`footer`/`inset`). |
| Table | `table.tsx` | `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`, `TableCaption`, `TableEmpty` | `density` `default`/`compact`; always scrolls inside its own container. Pair with `<Panel inset>`. |
| Stat | `stat.tsx` | `Stat`, `StatGroup` | KPI tile (`label`/`value`/`delta`/`trend`/`intent`/`tone`) and its hairline-divided row frame. |
| EmptyState | `empty-state.tsx` | `EmptyState` | zero-data block (`icon`/`title`/`description`/`action`); `variant` `plain`/`dashed`/`muted`. |
| KeyValueList | `key-value-list.tsx` | `KeyValueList` | `<dl>` for dense metadata; `dense` and `stacked` layouts. |
| CopyButton | `copy-button.tsx` | `CopyButton`, `useCopyToClipboard` | copy-to-clipboard affordance with a transient "copied" state. |

### Navigation

| Component | File | Parts / API | Notes |
|-----------|------|-------------|-------|
| Tabs | `tabs.tsx` | `Tabs`, `TabsList`, `TabsTab`, `TabsPanel`, `TabsIndicator` | `TabsList` `variant` `default`/`underline`; values are strings. |

### Overlays

| Component | File | Parts / API | Notes |
|-----------|------|-------------|-------|
| Dialog | `dialog.tsx` | `Dialog`, `DialogTrigger`, `DialogPopup`, `DialogHeader`, `DialogPanel`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose` | trigger/close use `render`. `portalProps` on `DialogPopup`. |
| Sheet | `sheet.tsx` | `Sheet`, `SheetTrigger`, `SheetPopup`, `SheetHeader`, `SheetPanel`, `SheetFooter`, `SheetTitle`, `SheetDescription`, `SheetClose` | `side` `top`/`bottom`/`left`/`right` on `SheetPopup`. |
| Menu | `menu.tsx` | `Menu`, `MenuTrigger`, `MenuPopup`, `MenuItem`, `MenuCheckboxItem`, `MenuRadioGroup`, `MenuRadioItem`, `MenuGroupLabel`, `MenuSeparator`, `MenuShortcut`, `MenuGroup`, `MenuSub`, `MenuSubTrigger`, `MenuSubPopup` | items use `onClick` (not `onSelect`). |
| Tooltip | `tooltip.tsx` | `Tooltip`, `TooltipTrigger`, `TooltipPopup`, `TooltipProvider` | wrap a subtree in `TooltipProvider`. |
| Popover | `popover.tsx` | `Popover`, `PopoverTrigger`, `PopoverClose`, `PopoverPopup`, `PopoverTitle`, `PopoverDescription` | `side`/`align`/`sideOffset` on `PopoverPopup`. |
| Toast | `toast.tsx` | `ToastProvider`, `ToastViewport`, `useToast` | mount provider + viewport once; `useToast().add({ title, description, type })`. |

### Brand

| Component | File | Parts / API | Notes |
|-----------|------|-------------|-------|
| Logo | `brand.tsx` | `OxagenLogo`, `OxagenLogomark`, `OxagenWordmark`, `OxagenLockup`, `BrandMark`, `NodeChip`, `ConfidenceBar` | `OxagenLogo` `variant` `mark`/`wordmark`/`horizontal`/`vertical`, `size` in px. |
| HexField | `hex-field.tsx` | `HexField` | Ambient hexagon backdrop. **Not in the barrel** — deep-import `@oxagen/ui/components/hex-field` through the app's re-export layer. |

### Providers / utilities

| Export | File | Notes |
|--------|------|-------|
| `ThemeProvider`, `useTheme`, `THEME_COOKIE_NAME`, `parseTheme`, `themeClass` | `theme-provider.tsx`, `theme-config.ts` | self-hosted, cookie-based, no-flash theming. |
| `MotionProvider` | `motion-provider.tsx` | motion config provider. |
| `GlobalErrorPage`, `NotFoundPage` | `global-error.tsx`, `not-found.tsx` | full-page templates. |
| `cn` | `lib/utils.ts` | `clsx` + `tailwind-merge`. |

## Styling

Colors, radius, and state come from CSS variables in
`src/styles/globals.css` (the value layer) mapped to Tailwind utilities via the
`@theme inline` block. **Reskin by editing tokens, not component class strings.**
Token values live in `src/styles/house-tokens.css`, vendored from the house kit; [`THEME.md`](./THEME.md) says which file answers which question and carries the rules a value cannot state.

## Scripts

```bash
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint, zero warnings
pnpm test:unit src/components/<name>.test.tsx   # one file; CI runs the suite
pnpm test:coverage      # vitest + coverage thresholds (CI)
pnpm storybook          # Storybook dev (:6008)
pnpm build-storybook    # static Storybook build
```
