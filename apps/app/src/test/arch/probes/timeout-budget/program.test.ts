// The type-checked budget, claimed by the walk it was measured on.
import ts from "typescript";
import { beforeAll, expect, it } from "vitest";
import {
  productionFiles,
  TYPE_CHECKED_TREE_TIMEOUT_MS,
} from "@/test/arch/parse";

function createProgram(roots: readonly string[]): ts.Program {
  return ts.createProgram(roots as string[], {});
}

let program: ts.Program;

beforeAll(() => {
  program = createProgram(productionFiles());
}, TYPE_CHECKED_TREE_TIMEOUT_MS);

it("reads the program the hook built", () => {
  expect(program.getSourceFiles().length).toBeGreaterThan(0);
});
