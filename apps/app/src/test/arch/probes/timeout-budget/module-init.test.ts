// Importing `files` runs the sibling's module initializer -- a whole-tree walk
// at collection scope, one module away.
import { expect, it } from "vitest";
import { files } from "./module-init-source";

it("reads a value the imported module gathered during its own collection", () => {
  expect(files.length).toBeGreaterThan(0);
});
