import { expect, it } from "vitest";
import { intersectEffectiveScope } from "./resolve";

it("returns a mathematical set for resourceScope skill intersection", () => {
  const effective = intersectEffectiveScope(
    { skills: { slugs: ["summarize", "summarize", "research"] } },
    { skills: { slugs: ["summarize"] } },
  );

  expect(effective.skills?.slugs).toEqual(["summarize"]);
});
