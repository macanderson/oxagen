---
name: coss-ui
description: Knowledge of coss ui — the Base UI–based component system used by @oxagen/ui (apps/app, apps/website, apps/admin). Covers the component registry and import paths, composition rules (the `render` prop, not `asChild`), the `*Popup`/`*Panel`/`Menu*`/`TabsTab`/`TabsPanel` naming, the Select items pattern, semantic color tokens and size scales, and the shadcn/Radix → coss migration mapping. Use when building, restyling, or reviewing UI that imports from `@oxagen/ui` (or `@/components/ui/*`), when migrating shadcn/Radix components to coss/Base UI, or when an overlay/menu/form control "renders empty" or drops children. For generic web-platform technique use frontend-patterns.
---

# coss ui

**coss ui** is a component system built on **[Base UI](https://base-ui.com/)**
(not Radix). In this monorepo it is implemented by the **`@oxagen/ui`** package
(`packages/ui/src/components`) and consumed through thin re-export proxies at
`apps/app/src/components/ui/*` (so app code imports `@/components/ui/<name>`).

The API is intentionally close to shadcn/ui, but with Base UI semantics. The
two rules that catch everyone:

1. **Composition uses the `render` prop, not Radix `asChild`.**
2. **Overlay/content parts are named `*Popup` / `*Panel`, not `*Content`.**

## Core rules (apply every time)

- **`render`, never `asChild`.** To render a part's styling/behaviour onto
  another element, pass a self-closing element to `render` and keep the visible
  content as the part's children:
  ```tsx
  // ✅ coss
  <Button render={<Link href="/login" />}>Login</Button>
  <MenuTrigger render={<Button variant="ghost" size="icon" />}><Bell /></MenuTrigger>
  // ❌ shadcn/Radix
  <Button asChild><Link href="/login">Login</Link></Button>
  ```
  The component forwards its children **into** the `render` element, so put
  icons/labels as children of the coss part — do **not** nest them inside the
  `render` element. (If a button/badge ever renders empty, this is why: an
  implementation that drops `children` when `render` is set is a bug — forward
  them.)
- **`onClick`, not `onSelect`** on `MenuItem`. Base UI closes the menu on click.
- **`*Popup` / `*Panel`, not `*Content`.** `DialogPopup`, `SheetPopup`,
  `SelectPopup`, `MenuPopup`; body wrappers are `DialogPanel`, `SheetPanel`,
  `CardPanel`. Tabs use `TabsTab` (control) and `TabsPanel` (panel).
- **Menus live in `menu.tsx`, not `dropdown-menu.tsx`.** Import from
  `@/components/ui/menu`; the part prefix is `Menu*`.
- **Multi-value controls take arrays** (`value={[50]}`, `defaultValue={["a"]}`)
  where Base UI is array-based (Slider, ToggleGroup, Accordion) — none of those
  ship in `@oxagen/ui` yet, but follow the rule if you add them.
- **Portals:** overlay popups accept an optional `portalProps` that forwards to
  the Base UI `*.Portal` (e.g. `keepMounted`, a custom `container`).

## `@oxagen/ui` component registry

Import from `@oxagen/ui` (barrel) or `@/components/ui/<file>` (app proxy).

| Component | File | Canonical parts | Notes |
|-----------|------|-----------------|-------|
| Button | `button.tsx` | `Button` (`render`) | sizes `xs/sm/default/lg/xl` + `icon/icon-sm/icon-lg`; variants incl. `destructive-outline`. coss sizes are compact — use `lg` to match a shadcn `default` (36px). |
| Badge | `badge.tsx` | `Badge` (`render`) | sizes `sm/default/lg` (`lg` = shadcn fixed size); variants `default/secondary/destructive/outline/muted/info/success/warning/error`. |
| Card | `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardPanel`, `CardFooter` | body wrapper is `CardPanel`. |
| Dialog | `dialog.tsx` | `Dialog`, `DialogTrigger`, `DialogPopup`, `DialogHeader`, `DialogPanel`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose` | `DialogPanel` wraps the body between header & footer. `portalProps` on `DialogPopup`. |
| Sheet | `sheet.tsx` | `Sheet`, `SheetTrigger`, `SheetPopup`, `SheetHeader`, `SheetPanel`, `SheetFooter`, `SheetTitle`, `SheetDescription`, `SheetClose` | `side` on `SheetPopup` (`top/bottom/left/right`). `portalProps`. |
| Menu | `menu.tsx` | `Menu`, `MenuTrigger`, `MenuPopup`, `MenuItem`, `MenuCheckboxItem`, `MenuRadioGroup`, `MenuRadioItem`, `MenuGroupLabel`, `MenuSeparator`, `MenuShortcut`, `MenuGroup`, `MenuSub`, `MenuSubTrigger`, `MenuSubPopup` | items use `onClick`; `align/side/sideOffset/portalProps` on `MenuPopup`. |
| Select | `select.tsx` | `Select`, `SelectTrigger`, `SelectValue`, `SelectPopup`, `SelectGroup`, `SelectLabel`, `SelectItem` | `size` on `SelectTrigger` (`sm/default/lg`); `alignItemWithTrigger`/`portalProps` on `SelectPopup`. For SSR prefer passing an `items` array to `Select`. |
| Tabs | `tabs.tsx` | `Tabs`, `TabsList`, `TabsTab`, `TabsPanel` | `TabsList` `variant="default" | "underline"`. `value/defaultValue` are strings. |
| Input | `input.tsx` | `Input` | `size` (`sm/default/lg`; `lg` = shadcn 36px). |
| Textarea | `textarea.tsx` | `Textarea` | `size` (`sm/default/lg`) — match neighbouring inputs. |
| Toast | `toast.tsx` | `ToastProvider`, `ToastViewport`, `useToast` | mount `<ToastProvider>` once; enqueue via `useToast().add({ title, description, type })`. |
| Label / Separator / Skeleton | resp. | `Label`, `Separator`, `Skeleton` | unchanged. |

(Brand/marketing helpers — `brand`, `marketing-hero`, `global-error`,
`not-found`, `theme-provider` — also live in `@oxagen/ui`.)

## Styling conventions

- **Tailwind v4 + design tokens.** Colors come from CSS variables in
  `packages/ui/src/styles/tokens.css`, mapped to utilities in the `@theme`
  block of `globals.css`. Restyle by editing tokens, not component class
  strings.
- **Semantic colors:** `bg-info` / `text-info-foreground`, and likewise
  `success`, `warning`, plus `destructive`. These back the Badge/Alert semantic
  variants — add the token pair before using a new semantic color.
- **Size scales are compact by design.** Button/Select/Input/Textarea default
  heights are one step smaller than shadcn; opt into `lg` for shadcn parity.
- **Icons:** Lucide, sized via the component (`[&_svg]:size-4`). Never emoji.

## shadcn/Radix → coss migration mapping

| shadcn / Radix | coss (`@oxagen/ui`) |
|----------------|---------------------|
| `asChild` | `render={<El />}` (children stay on the coss part) |
| `onSelect` (menu item) | `onClick` |
| `DropdownMenu*` (`@/components/ui/dropdown-menu`) | `Menu*` (`@/components/ui/menu`) |
| `DropdownMenuContent` / `DropdownMenuSubContent` | `MenuPopup` / `MenuSubPopup` |
| `DropdownMenuLabel` | `MenuGroupLabel` |
| `DialogContent` / `SheetContent` / `SelectContent` | `DialogPopup` / `SheetPopup` / `SelectPopup` |
| `CardContent` | `CardPanel` |
| `TabsTrigger` / `TabsContent` | `TabsTab` / `TabsPanel` |
| `<Badge variant="warn">` | `<Badge variant="warning">` |
| `Toaster` (Sonner) | `<ToastProvider>` + `useToast().add(...)` |

## Common pitfalls

- **Empty button/badge with `render`.** The icon/label must be the **children**
  of the coss part (`<Button render={<a href />}><Icon/></Button>`), and the
  component must forward children into the render element. Don't move content
  inside the `render` element.
- **Stale `*Content` names.** After migrating, typecheck — `tsc` flags any
  leftover `DialogContent` / `TabsTrigger` / etc.
- **`onSelect` left on a `MenuItem`** silently does nothing — rename to
  `onClick`.
- **Select SSR/hydration.** Provide `items` so values/labels are known before
  hydration; otherwise format the selected label via a function child on
  `SelectValue`.

## References

- Base UI: https://base-ui.com/
- Component source of truth: `packages/ui/src/components/*` in this repo.
- For migrating an existing surface, follow the mapping table above and verify
  with `pnpm --filter @oxagen/app typecheck && pnpm --filter @oxagen/app lint`.
