// Class-name join for the Mission Control primitives. The primitives compose
// their own token classes, so a join is enough; they never need tailwind-merge.
export type ClassValue = string | false | null | undefined;

export function cx(...classes: readonly ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
