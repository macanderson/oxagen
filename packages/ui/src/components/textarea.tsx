import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const textareaVariants = cva(
  // `max-md:text-base` prevents iOS Safari focus auto-zoom (fonts <16px).
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm max-md:text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
  {
    // coss ui density scale. Match the `size` you use on neighbouring inputs
    // (e.g. `lg`) for visual consistency.
    variants: {
      size: {
        sm: "min-h-[52px]",
        default: "min-h-[60px]",
        lg: "min-h-[72px]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, size, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(textareaVariants({ size }), className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea, textareaVariants };
