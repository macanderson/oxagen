// A parse-only walk claiming the ten-minute budget meant for a type-checked
// program: the name is right, the reason for it is absent.
import { expect, it } from "vitest";
import {
  productionFiles,
  readSource,
  TYPE_CHECKED_TREE_TIMEOUT_MS,
} from "@/test/arch/parse";

it(
  "walks the tree on the type-checked budget",
  () => {
    expect(productionFiles().map(readSource).length).toBeGreaterThan(0);
  },
  TYPE_CHECKED_TREE_TIMEOUT_MS,
);
