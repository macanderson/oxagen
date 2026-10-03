// The kit's button: shadcn's button in the base-maia style (ADR-221), over
// Base UI's button. Its classes live in button-variants.ts, so a link styled as
// a button reads the same ones. Every button in the app is this component with
// one of its variants (INV-37).
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { VariantProps } from "class-variance-authority";
import { buttonVariants } from "./button-variants";
import { cn } from "./cn";

type Variants = VariantProps<typeof buttonVariants>;

/**
 * A button names its variant: `primary` for the one gold action on a screen,
 * and `secondary`, `outline`, `ghost`, `destructive`, `destructive-outline`
 * or `link` for every other. The type requires it, so no button turns gold by
 * leaving it out.
 */
type ButtonProps = ButtonPrimitive.Props & {
  variant: NonNullable<Variants["variant"]>;
  size?: Variants["size"];
};

export function Button({
  className,
  variant,
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
