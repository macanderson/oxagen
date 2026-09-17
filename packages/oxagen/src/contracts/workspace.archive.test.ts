import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { workspaceArchive } from "./workspace.archive";

describe("archive_workspace contract", () => {
  it("is a settings write for org Owners and Admins: noBillingGate, mutates, deny by default", () => {
    expect(getCapability("archive_workspace")).toBe(workspaceArchive);
    expect(workspaceArchive.noBillingGate).toBe(true);
    expect(workspaceArchive.mutates).toBe(true);
    expect(workspaceArchive.scoped).toBe(true);
    expect(workspaceArchive.defaultEffect).toBe("deny");
    expect(workspaceArchive.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(workspaceArchive.layers).not.toContain("e2e");
  });

  it("takes a public workspace id and refuses a slug or a uuid (negative)", () => {
    expect(workspaceArchive.input.parse({ workspaceId: "wrk_abc" })).toEqual({
      workspaceId: "wrk_abc",
    });
    expect(
      workspaceArchive.input.safeParse({ workspaceId: "core" }).success,
    ).toBe(false);
    expect(
      workspaceArchive.input.safeParse({
        workspaceId: "3f6c2b1e-0000-4000-8000-000000000000",
      }).success,
    ).toBe(false);
  });

  it("answers with the archived workspace and when it was archived", () => {
    const parsed = workspaceArchive.output.parse({
      id: "wrk_abc",
      slug: "core",
      name: "Core",
      archivedAt: "2026-09-15T00:00:00.000Z",
    });
    expect(parsed.archivedAt).toBe("2026-09-15T00:00:00.000Z");
  });
});
