// An imported helper that reaches no enumeration. Widening the fixpoint to the
// program must not make "imported" mean "walks the tree".
import { expect, it } from "vitest";
import { readOne } from "./imported-walker";

it("reads one file and needs no budget", () => {
  expect(readOne()).toBeGreaterThan(0);
});
