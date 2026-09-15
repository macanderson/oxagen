// INV-26 (ARCHITECTURE.md §4): the one accessibility check a section test runs
// in each state it renders, over the container React Testing Library rendered
// into. It runs axe-core's WCAG 2.x A and AA rules, the statement of INV-26.
import axe from "axe-core";
import { expect } from "vitest";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/**
 * Base UI's focus manager brackets an open popup with invisible 1px focus
 * guards, rendered as unnamed `role="button"` spans when `navigator.vendor`
 * reads Apple (jsdom's does). They belong to the library, not to the section.
 */
const FOCUS_GUARDS = "[data-base-ui-focus-guard]";

/** Fails naming each violated rule and the markup it found. */
export async function expectNoAxe(container: Element): Promise<void> {
  const results = await axe.run(
    { include: [container], exclude: [FOCUS_GUARDS] },
    { runOnly: { type: "tag", values: WCAG } },
  );
  const violations = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.html).join(" | ")}`,
  );
  expect(violations, violations.join("\n")).toEqual([]);
}
