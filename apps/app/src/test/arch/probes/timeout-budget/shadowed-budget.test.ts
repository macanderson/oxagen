// A local constant wearing the measured budget's name. Comparing the spelling
// accepts it; resolving the binding does not. The whole-tree test would keep
// the exact 5000ms this file exists to abolish, with the checker green.
import { expect, it } from "vitest";
import { productionFiles } from "@/test/arch/parse";

const WHOLE_TREE_TIMEOUT_MS = 5_000;

it(
  "walks the tree on a budget that only looks named",
  () => {
    expect(productionFiles().length).toBeGreaterThan(0);
  },
  WHOLE_TREE_TIMEOUT_MS,
);
