import { expect, it } from "vitest";
import { intersectEffectiveScope } from "./resolve";

it("returns a mathematical set for resourceScope label intersection", () => {
  const effective = intersectEffectiveScope(
    { graph: { labels: ["Person", "Person", "Company"] } },
    { graph: { labels: ["Person"] } },
  );

  expect(effective.graph?.labels).toEqual(["Person"]);
});
