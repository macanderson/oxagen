import { houseTypeMerge } from "@oxagen/ui/lib/house-type-merge";
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge that files the house type utilities as font sizes. */
const twMerge = extendTailwindMerge(houseTypeMerge);

/**
 * Joins class names, and lets a later Tailwind class win over an earlier one
 * that sets the same property, so a caller's `className` overrides a
 * component's default. `components.json` names this file as shadcn's `utils`,
 * so a component written from the shadcn registry imports it unchanged
 * (ADR-221). A house type utility such as `text-a-h3` keeps its place beside a
 * text colour, because `houseTypeMerge` files it under font size (#5185).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
