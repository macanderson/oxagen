// The same imported walker, called inside an inline callback instead.
import { expect, it } from "vitest";
import { scan } from "./imported-walker";

it("scan", () => {
  expect(scan().length).toBeGreaterThan(0);
});
