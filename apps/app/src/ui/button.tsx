// shadcn's button in the base-maia style (ADR-221), written from
// `ui.shadcn.com/r/styles/base-maia/button.json` over Base UI's button. The
// maia shape stays: a pill, 36px tall by default, 14px text, a 16px glyph.
// The colours are the house's button tokens rather than shadcn's `primary`,
// which `design-record.test.ts` keeps out of component files (INV-32), and
// focus draws the house outline every other control draws.
//
// `default` is the gold action. A screen carries at most one, so a pager, a
// close glyph or a toolbar reaches for `ghost` or `outline`.
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-4xl border border-transparent bg-clip-padding text-base font-medium whitespace-nowrap transition-all select-none " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
    "active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 " +
    "aria-invalid:border-input-invalid-border [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-button-primary-border bg-button-primary-bg font-semibold text-button-primary-fg hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg",
        outline:
          "border-button-default-border bg-button-default-bg text-button-default-fg hover:bg-button-default-hover-bg hover:text-foreground aria-expanded:bg-button-default-hover-bg aria-expanded:text-foreground",
        secondary:
          "bg-muted text-foreground hover:bg-hl aria-expanded:bg-hl",
        ghost:
          "text-muted-foreground hover:bg-hl hover:text-foreground aria-expanded:bg-hl aria-expanded:text-foreground",
        destructive:
          "bg-error/10 text-error-ink hover:bg-error/20 focus-visible:outline-error",
        link: "text-link underline-offset-4 hover:text-link-hover hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
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

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants>;

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
