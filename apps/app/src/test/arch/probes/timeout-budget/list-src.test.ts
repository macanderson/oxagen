// listFiles("src") is the other whole-tree enumeration.
import { expect, it } from "vitest";
import { listFiles, readSource } from "@/test/arch/parse";

it("lists every file under src", () => {
  expect(listFiles("src").map(readSource).length).toBeGreaterThan(0);
});
