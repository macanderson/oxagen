import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/*
 * Input — fully token-driven (--input-* tokens), no decorative transition or
 * shadow. A constant 1px border at rest means the focus/invalid states only
 * change COLOR, never width, so the field never shifts layout. Invalid state is
 * wired via both Base UI `data-[invalid]` (when inside a Field) and native
 * `aria-invalid` (bare inputs).
 */
const inputVariants = cva(
  "flex w-full rounded-md border border-input-border bg-input-bg px-3 py-1 text-sm text-input-fg transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-input-placeholder hover:border-input-border-hover focus-visible:outline-none focus-visible:border-input-border-focus focus-visible:ring-1 focus-visible:ring-input-ring data-[invalid]:border-input-invalid-border data-[invalid]:focus-visible:ring-input-invalid-ring aria-[invalid=true]:border-input-invalid-border aria-[invalid=true]:focus-visible:ring-input-invalid-ring disabled:cursor-not-allowed disabled:bg-input-disabled-bg disabled:text-input-disabled-fg",
  {
    // coss ui density scale. `lg` matches the shadcn/ui input height (36px).
    variants: {
      size: {
        sm: "h-7",
        default: "h-8",
        lg: "h-9",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input, inputVariants };
