// A hook walks the tree on hookTimeout unless it says otherwise.
import { beforeAll, expect, it } from "vitest";
import { productionFiles, readSource } from "@/test/arch/parse";

let files: readonly { readonly file: string }[] = [];

beforeAll(() => {
  files = productionFiles().map(readSource);
});

it("reads what the hook gathered", () => {
  expect(files.length).toBeGreaterThan(0);
});
