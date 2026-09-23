import { describe, expect, it } from "vitest";
import { parseRepositoryView } from "./view";

describe("parseRepositoryView", () => {
  it("reads the bare route as the Repositories tab", () => {
    expect(parseRepositoryView(undefined)).toEqual({
      tab: "repositories",
      change: null,
    });
    expect(parseRepositoryView([])).toEqual({
      tab: "repositories",
      change: null,
    });
  });

  it("reads each other tab from its one path segment", () => {
    expect(parseRepositoryView(["working-copies"])?.tab).toBe("working-copies");
    expect(parseRepositoryView(["changes"])).toEqual({
      tab: "changes",
      change: null,
    });
    expect(parseRepositoryView(["configuration"])?.tab).toBe("configuration");
  });

  it("reads one change on the Changes tab", () => {
    expect(parseRepositoryView(["changes", "oxpr_01K6T4B7"])).toEqual({
      tab: "changes",
      change: "oxpr_01K6T4B7",
    });
  });

  it("refuses an unknown segment, a change on another tab, a third segment, and the first tab spelled out (negative)", () => {
    expect(parseRepositoryView(["settings"])).toBeNull();
    expect(parseRepositoryView(["configuration", "prp_1"])).toBeNull();
    expect(parseRepositoryView(["changes", "prp_1", "x"])).toBeNull();
    expect(parseRepositoryView(["changes", "a b"])).toBeNull();
    expect(parseRepositoryView(["repositories"])).toBeNull();
  });
});
