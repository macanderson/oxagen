# ADR-221: The app takes shadcn's base-maia style on Base UI

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** app
- **Related:** issues #4691 (toast), #4692 (hover card), #4693 (pagination),
  #4694 (message scroller), #4674 and PR #4669 (the cut-cell tooltip),
  `apps/app/components.json`, `apps/app/ARCHITECTURE.md` INV-12, INV-26 and
  INV-32.

## Context

`apps/app` draws its own components in `src/ui/` on Base UI
(`@base-ui/react`). Each one was written by hand from the mockup, so a toast,
a pager, a tooltip and a menu each carry their own classes, and none of them
shares a shape with the others.

Mac asked for four shadcn components on 2026-09-28: the message scroller in
the in-app assistant, pagination with the rows-per-page select at the foot of
the list, hover cards for cut text, and toasts. Mac then pointed at the
shadcn preset `b6FlQHSba` and named what to keep from it: the translucent
drop-downs, and the way maia sets radius, font size and spacing. Mac also
asked for Phosphor icons. Mac did not want the rest of the preset.

shadcn publishes a Base UI flavour of each component. Its registry serves
them per style at `https://ui.shadcn.com/r/styles/<style>/<name>.json`, and
`base-maia` is the style the preset uses.

## Decision

`apps/app` takes shadcn's `base-maia` style on Base UI, on Oxagen's colour
tokens and fonts.

1. **Source.** A shadcn component is written into `src/ui/<name>.tsx` by hand
   from the `base-maia` registry file, and imported as `@/ui/<name>`. The
   `shadcn` CLI does not run in this tree, because `shadcn add` installs
   dependencies and rewrites `globals.css`. `apps/app/components.json` records
   the style, the Phosphor icon library, the translucent menus
   (`menuColor: default-translucent`, `menuAccent: subtle`) and the `@/ui`
   aliases, so a registry file's imports resolve unchanged and the next
   author reads the choice in one place.
2. **What maia sets.** Controls are pills (`rounded-4xl`) 36px tall, text is
   `text-sm`, popups are `rounded-2xl` and their items `rounded-xl`, and
   spacing follows the registry (`gap-2.5`, `px-3 py-2`).
3. **Translucent popups.** A menu, select, hover card, popover or toast fills at 70%
   of its surface token, with a `backdrop-blur-2xl backdrop-saturate-150`
   layer behind it and a `ring-1 ring-foreground/5` edge. The blur sits on a
   `before:` layer so it does not become the containing block for the
   popup's own positioned children.
4. **Colour.** Every colour is an Oxagen token. A component never uses
   shadcn's `primary`, which `design-record.test.ts` keeps out of component
   files (INV-32). The gold appears only on `Button`'s `default` variant, the
   one action a screen may carry. The preset's zinc theme, its font and its
   chart colours are not taken.
5. **Icons.** Components use `@phosphor-icons/react` with the `*Icon` names.
   A server component imports from `@phosphor-icons/react/ssr`.
   `lucide-react` stayed a dependency until the last file that imported it
   moved. That happened on 2026-09-28, and the app no longer depends on it.
6. **Class merging.** `src/ui/cn.ts` is shadcn's `cn`: `clsx`, then
   `tailwind-merge`, so a caller's `className` wins over a component's
   default. `components.json` names it as `utils`.
7. **Primitives.** Base UI supplies the toast, the hover card (its
   `PreviewCard`), the select, the field and the button. `@shadcn/react`
   supplies the message scroller, which Base UI does not have.
8. **Strings.** Every default string a primitive or registry file carries,
   such as "Notifications", "Close toast", "Previous", "Next" and "Scroll to
   end", is passed in from the catalogues (INV-12).

A registry file's classes are copied inline, as the registry writes them.
A shared recipe in `src/ui/control-styles.ts` can replace a repeated string
later without changing a caller.

## Consequences

- `apps/app` gains five dependencies, pinned: `@phosphor-icons/react`,
  `@shadcn/react`, `class-variance-authority`, `clsx` and `tailwind-merge`.
  knip fails the build if production code stops importing one of them.
- One truncation mechanism remains. The #4669 cell tooltip becomes the hover
  card, and it also covers text marked `data-truncate` outside tables.
- One toaster is mounted in the root layout, in place of a stack per feature.
- A component taken from the registry later follows the same steps: copy the
  `base-maia` file, map its colours to Oxagen tokens, move its strings into
  the catalogues, and add a test beside it that runs `expectNoAxe`.
- Updating a component means reading its registry file again and merging by
  hand. There is no `shadcn diff` step, because the CLI does not run here.
