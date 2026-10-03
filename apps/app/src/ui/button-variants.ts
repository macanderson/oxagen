// The kit Button's classes, by variant and size (#5283). `Button`
// (src/ui/button.tsx) draws them over Base UI's button, and a link styled as a
// button reads the same classes through the recipes in control-styles.ts, so
// a link and a button never drift apart.
//
// The maia shape stays: a pill, 36px tall by default, 14px text, a 16px glyph.
// A phone raises the default size to the 44px touch target. The colours are
// the house's button tokens rather than shadcn's `primary`, which
// `design-record.test.ts` keeps out of component files (INV-32), and focus
// draws the house outline every other control draws.
//
// `primary` and `default` are the gold action, from --button-primary-*. A
// screen carries at most one, so every other button names `secondary`,
// `outline`, or `ghost`, the neutral set from --button-default-*.
// `destructive` and `destructive-outline` read the error token, and `link` is
// text only.
import { cva } from "class-variance-authority";

const gold =
  "border-button-primary-border bg-button-primary-bg font-semibold text-button-primary-fg hover:border-button-primary-hover-bg hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg";

export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-4xl border border-transparent bg-clip-padding text-base font-medium whitespace-nowrap transition-all select-none " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
    "active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 " +
    "aria-invalid:border-input-invalid-border [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: gold,
        default: gold,
        outline:
          "border-button-default-border bg-button-default-bg text-button-default-fg hover:border-rule hover:bg-button-default-hover-bg hover:text-foreground active:bg-button-default-active-bg aria-expanded:bg-button-default-hover-bg aria-expanded:text-foreground",
        secondary:
          "bg-muted text-foreground hover:bg-hl aria-expanded:bg-hl",
        ghost:
          "text-muted-foreground hover:bg-hl hover:text-foreground aria-expanded:bg-hl aria-expanded:text-foreground",
        destructive:
          "bg-error/10 text-error-ink hover:bg-error/20 focus-visible:outline-error",
        "destructive-outline":
          "border-error/40 bg-button-default-bg text-error-ink hover:bg-error/10 active:bg-error/15 focus-visible:outline-error",
        link: "text-link underline-offset-4 hover:text-link-hover hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 max-md:min-h-11 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2.5 text-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
