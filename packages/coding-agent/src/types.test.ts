import { describe, it, expect } from "vitest";
import type { Workspace, CodingEvent } from "./types";

describe("types", () => {
  it("CodingEvent union includes final-diff", () => {
    const e: CodingEvent = { type: "final-diff", diff: "", changedFiles: [] };
    expect(e.type).toBe("final-diff");
  });
  it("Workspace shape is structurally usable", () => {
    const w: Pick<Workspace, "root"> = { root: "/tmp/repo" };
    expect(w.root).toBe("/tmp/repo");
  });
});
