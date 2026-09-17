// The root reaches listFiles as a widened `string`, so its value cannot be
// pinned to a subtree: it may be the whole tree, and must carry a budget.
import { expect, it } from "vitest";
import { listFiles } from "@/test/arch/parse";

const root: string = process.env["ARCH_ROOT"] ?? "src";

it("walks a root the checker cannot pin", () => {
  expect(listFiles(root).length).toBeGreaterThan(0);
});
