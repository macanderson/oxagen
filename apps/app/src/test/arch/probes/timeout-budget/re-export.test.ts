// The enumerator arrives through another module and under another name.
import { expect, it } from "vitest";
import { productionFiles as walk } from "./re-exported-source";

it("walks the tree through a re-export", () => {
  expect(walk().length).toBeGreaterThan(0);
});
