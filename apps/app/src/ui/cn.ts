/**
 * Joins class names, and lets a later Tailwind class win over an earlier one
 * that sets the same property, so a caller's `className` overrides a
 * component's default. `components.json` names this file as shadcn's `utils`,
 * so a component written from the shadcn registry imports it unchanged
 * (ADR-221).
 *
 * The helper itself lives in `@oxagen/ui`, which every app shares. It files the
 * house type utilities (`text-a-*`, `text-m-*`) as font sizes, so a text
 * colour beside one keeps both (#5185).
 */
export { cn } from "@oxagen/ui/lib/utils";
