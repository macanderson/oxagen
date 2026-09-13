import { describe, expect, it } from "vitest";
import { FIXTURE_ORG, FIXTURE_WORKSPACES } from "@/server/fixture-tenancy";
import { FIXTURE_TENANT, fixtureWorkspaceSlug } from "./fixture-tenant";
import { ORG_ONLY_WORKSPACE_ID } from "./scope";

describe("the fixture tenant", () => {
  it("is the fixture tenancy requireViewer resolves viewers against", () => {
    expect(FIXTURE_TENANT.orgId).toBe(FIXTURE_ORG.id);
    expect(Object.values(FIXTURE_TENANT.workspaces).sort()).toEqual(
      FIXTURE_WORKSPACES.map((w) => w.id).sort(),
    );
  });

  it("names the fixture workspace a scope carries", () => {
    expect(
      fixtureWorkspaceSlug(FIXTURE_TENANT.workspaces["core-platform"]),
    ).toBe("core-platform");
    expect(fixtureWorkspaceSlug(FIXTURE_TENANT.workspaces.finops)).toBe(
      "finops",
    );
  });

  it("is null for the org-only scope and an unknown workspace (negative)", () => {
    expect(fixtureWorkspaceSlug(ORG_ONLY_WORKSPACE_ID)).toBeNull();
    expect(
      fixtureWorkspaceSlug("913d6df1-0000-4000-8000-000000000000"),
    ).toBeNull();
  });
});
