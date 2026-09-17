// The same shape in a hook: beforeAll is handed the enumerator directly.
import { beforeAll, expect, it } from "vitest";
import { productionFiles } from "@/test/arch/parse";

beforeAll(productionFiles);

it("reads nothing in particular", () => {
  expect(1).toBe(1);
});
