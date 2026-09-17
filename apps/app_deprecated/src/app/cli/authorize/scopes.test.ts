import { describe, it, expect } from "vitest";
import { groupCliAuthScopes, type CliAuthScopeRow } from "./scopes";

function row(over: Partial<CliAuthScopeRow>): CliAuthScopeRow {
  return {
    orgId: "org-1",
    orgSlug: "oxagen",
    orgName: "Oxagen",
    workspaceId: "ws-1",
    workspaceSlug: "default",
    workspaceName: "Customer ABC",
    membershipId: "m-1",
    ...over,
  };
}

describe("groupCliAuthScopes", () => {
  it("lists one org with the workspaces the user is a member of", () => {
    const orgs = groupCliAuthScopes([
      row({}),
      row({
        workspaceId: "ws-2",
        workspaceSlug: "prod",
        workspaceName: "Production",
        membershipId: "m-2",
      }),
    ]);
    expect(orgs).toEqual([
      {
        id: "org-1",
        slug: "oxagen",
        name: "Oxagen",
        workspaces: [
          { id: "ws-1", slug: "default", name: "Customer ABC" },
          { id: "ws-2", slug: "prod", name: "Production" },
        ],
      },
    ]);
  });

  it("keeps an org whose workspaces the user cannot use, with none listed", () => {
    const orgs = groupCliAuthScopes([
      row({ membershipId: null }),
      row({
        orgId: "org-2",
        orgSlug: "empty",
        orgName: "Empty Org",
        workspaceId: null,
        workspaceSlug: null,
        workspaceName: null,
        membershipId: null,
      }),
    ]);
    expect(orgs.map((o) => [o.slug, o.workspaces.length])).toEqual([
      ["oxagen", 0],
      ["empty", 0],
    ]);
  });

  it("collapses a workspace repeated across duplicate membership rows", () => {
    const orgs = groupCliAuthScopes([row({}), row({ membershipId: "m-9" })]);
    expect(orgs[0]?.workspaces).toHaveLength(1);
  });

  it("preserves row order for orgs and workspaces", () => {
    const orgs = groupCliAuthScopes([
      row({ orgId: "org-b", orgSlug: "b", orgName: "B" }),
      row({ orgId: "org-a", orgSlug: "a", orgName: "A" }),
    ]);
    expect(orgs.map((o) => o.slug)).toEqual(["b", "a"]);
  });
});
