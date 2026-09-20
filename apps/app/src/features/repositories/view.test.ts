import { describe, expect, it } from "vitest";
import { parseRepositoryTab } from "./view";

describe("parseRepositoryTab", () => {
  it("reads the bare route as the Repositories tab", () => {
    expect(parseRepositoryTab(undefined)).toBe("repositories");
    expect(parseRepositoryTab([])).toBe("repositories");
  });

  it("reads each other tab from its one path segment", () => {
    expect(parseRepositoryTab(["working-copies"])).toBe("working-copies");
    expect(parseRepositoryTab(["changes"])).toBe("changes");
    expect(parseRepositoryTab(["configuration"])).toBe("configuration");
  });

  it("refuses an unknown segment, a second segment, and the first tab spelled out (negative)", () => {
    expect(parseRepositoryTab(["settings"])).toBeNull();
    expect(parseRepositoryTab(["changes", "prp_1"])).toBeNull();
    expect(parseRepositoryTab(["repositories"])).toBeNull();
  });
});
