import { expect, it } from "vitest";
import { intersectEffectiveScope } from "./resolve";

it("does not widen a disjoint effective graph scope when a parent ceiling is applied", () => {
  const disjointEffectiveScope = intersectEffectiveScope(
    { graph: { labels: ["Person"] } },
    { graph: { labels: ["Company"] } },
  );

  expect(disjointEffectiveScope.graph?.labels).toEqual([]);

  const childScope = intersectEffectiveScope(disjointEffectiveScope, {
    graph: { labels: ["Person"] },
  });

  expect(childScope.graph?.labels).toEqual([]);
});
