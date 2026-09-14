import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** WCAG 2.2 A/AA plus best practice: the accessibility floor for every page. */
export const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
];

/** Fail the test on any axe violation on the current page, naming each rule and target. */
export async function expectNoAxeViolations(
  page: Page,
  options: { exclude?: string[] } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  for (const selector of options.exclude ?? [])
    builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  const summary = violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(summary).toEqual([]);
}
