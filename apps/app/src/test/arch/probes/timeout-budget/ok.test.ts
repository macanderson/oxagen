// Clean: each whole-tree walk sits in a registrar's callback and names a budget.
import { beforeAll, describe, expect, it } from "vitest";
import {
  listFiles,
  productionFiles,
  readSource,
  WHOLE_TREE_TIMEOUT_MS,
} from "@/test/arch/parse";

function scanned(): string[] {
  return listFiles("src");
}

let files: string[] = [];

beforeAll(() => {
  files = productionFiles();
}, WHOLE_TREE_TIMEOUT_MS);

describe("probe", () => {
  it(
    "walks the tree directly",
    () => {
      expect(productionFiles().map(readSource).length).toBeGreaterThan(0);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "walks it through a helper",
    () => {
      expect(scanned().length).toBeGreaterThan(0);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("reads one file and needs no budget", () => {
    expect(readSource("src/data/ports.ts").text.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThanOrEqual(0);
  });
});
