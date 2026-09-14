import { describe, expect, it } from "vitest";
import { liveSource } from "./adapters/live";
import { dataSource } from "./source";

describe("dataSource", () => {
  it("returns the live source", () => {
    expect(dataSource()).toBe(liveSource);
  });
});
