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

  it("answers with the archived workspace, when it was archived, and how many keys stopped", () => {
    const parsed = workspaceArchive.output.parse({
      id: "wrk_abc",
      slug: "core",
      name: "Core",
      archivedAt: "2026-09-15T00:00:00.000Z",
      suspendedApiKeys: 2,
    });
    expect(parsed.archivedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(parsed.suspendedApiKeys).toBe(2);
  });

  it("refuses an answer that does not say what happened to the keys (negative)", () => {
    // ADR-104: archival suspends the workspace's keys. A caller that is not
    // told how many is not told the call had a credential effect at all.
    expect(
      workspaceArchive.output.safeParse({
        id: "wrk_abc",
        slug: "core",
        name: "Core",
        archivedAt: "2026-09-15T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      workspaceArchive.output.safeParse({
        id: "wrk_abc",
        slug: "core",
        name: "Core",
        archivedAt: "2026-09-15T00:00:00.000Z",
        suspendedApiKeys: -1,
      }).success,
    ).toBe(false);
  });
});
