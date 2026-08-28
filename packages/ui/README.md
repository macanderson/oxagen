# @oxagen/ui

**coss ui** — the shared component system for every Oxagen app (`app`, `docs`,
`web`, and the rest of the monorepo's apps). Built on **[Base UI](https://base-ui.com/)**
(not Radix) and **Tailwind v4** with a fully token-driven theme.

The package ships **raw TypeScript source** — there is no build step. Apps
consume it via `transpilePackages` and import either from the barrel
(`@oxagen/ui`) or, in `apps/*`, through the local re-export proxy
(`@/components/ui/<name>`). App code must **never** import
`@oxagen/ui/components/*` directly (see root `CLAUDE.md`).

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

Rendered proof of the running Storybook lives in
[`docs/verifications/`](../../docs/verifications) (overview, button/badge
variants, dark-mode card, dialog overlay).

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
| Combobox | `combobox.tsx` | `Combobox`, `ComboboxTrigger`, `ComboboxValue`, `ComboboxPopup`, `ComboboxItem` | searchable typeahead — use for >20 options. |

### Surfaces

| Component | File | Parts / API | Notes |
|-----------|------|-------------|-------|
| Card | `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardPanel`, `CardFooter` | body wrapper is `CardPanel`. |
| Panel | `panel.tsx` | `Panel` | titled surface block (`eyebrow`/`title`/`actions`/`footer`/`inset`). |

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
See [`THEME.md`](./THEME.md) for the full token reference.

## Scripts

```bash
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint, zero warnings
pnpm test:unit          # vitest
pnpm test:coverage      # vitest + coverage thresholds
pnpm storybook          # Storybook dev (:6008)
pnpm build-storybook    # static Storybook build
```
