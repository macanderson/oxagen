/**
 * sidebar-item-affordance.ts — pure logic for SidebarItem affordance selection.
 *
 * Extracted to a plain .ts module so it can be imported in node-environment
 * vitest tests without requiring JSX/DOM support.
 */

export type SidebarItemAffordance = "external" | "return" | "none";

/**
 * Returns which affordance icon to render given the item's boolean flags.
 * isReturn takes precedence over external when both are set.
 */
export function sidebarItemAffordance(opts: {
  external?: boolean;
  isReturn?: boolean;
}): SidebarItemAffordance {
  if (opts.isReturn) return "return";
  if (opts.external) return "external";
  return "none";
}
