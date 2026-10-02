import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The steps of the two house type scales. `styles/house-tailwind.css` turns
 * each one into a `text-a-<step>` and a `text-m-<step>` utility. The test
 * beside this file reads that stylesheet and fails when it adds a step this
 * list lacks.
 */
const TYPE_STEPS = ["h1", "h2", "h3", "h4", "body", "micro"] as const;

/**
 * tailwind-merge with the house type utilities in its `font-size` group.
 *
 * Its default config does not know `text-a-h3` or `text-m-body`, so it reads
 * them as a text colour. A colour class such as `text-foreground` in the same
 * list then wins, and the size is dropped (#5185). In the `font-size` group, a
 * house size conflicts only with another size, such as `text-sm` or
 * `text-a-h1`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [{ a: TYPE_STEPS, m: TYPE_STEPS }] }],
    },
  },
});

/**
 * Joins class names, and lets a later Tailwind class win over an earlier one
 * that sets the same property, so a caller's `className` overrides a
 * component's default. Every app re-exports this one, so all of product
 * merges classes the same way.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
