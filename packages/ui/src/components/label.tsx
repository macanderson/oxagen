import * as React from "react";
import { cn } from "../lib/utils";

/**
 * Label — a styled native `<label>`. Base UI has no standalone label primitive
 * (it exposes `Field.Label` inside a `Field.Root`); for the common standalone
 * case a native element with `htmlFor` is the stock, fully-accessible choice.
 */
const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
