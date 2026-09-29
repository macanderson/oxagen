import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names, and lets a later Tailwind class win over an earlier one
 * that sets the same property, so a caller's `className` overrides a
 * component's default. `components.json` names this file as shadcn's `utils`,
 * so a component written from the shadcn registry imports it unchanged
 * (ADR-221).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
