/**
 * holdsCapability asks the IAM resolver whether a user holds a capability.
 * The resolver runs for real. Only its Postgres read and the tenant scope it
 * enters are replaced, so each case below is an organization's IAM data and
 * the answer the resolver gives for it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  authz: {
    principal: null as unknown,
    grants: [] as unknown[],
    roles: [] as unknown[],
    roleGrants: [] as unknown[],
    policies: [] as unknown[],
  },
  fetchAuthz: vi.fn(),
  scopes: [] as unknown[],
}));

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (scope: unknown, fn: () => unknown) => {
      mocks.scopes.push(scope);
      return fn();
    },
  };
});

vi.mock("@oxagen/iam", () => ({
  fetchAuthz: (args: unknown) => {
    mocks.fetchAuthz(args);
    return Promise.resolve(mocks.authz);
  },
}));

import { holdsCapability } from "./capability-holder";

const ORG = "org-1";
const WS = "ws-1";
const USER = "user-1";
const PRINCIPAL = "prn-1";
const CAPABILITY = {
  name: "merge_pr_without_review",
  defaultEffect: "deny" as const,
};

function role(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: "Reviewers",
    scopeKind: "org",
    orgId: ORG,
    principalIds: [PRINCIPAL],
    isSystemDefault: false,
    ...over,
  };
}

function grant(roleId: string, effect: string) {
  return { roleId, capabilityId: CAPABILITY.name, effect };
}

const holds = () =>
  holdsCapability(CAPABILITY, { orgId: ORG, workspaceId: WS }, USER);

beforeEach(() => {
  mocks.authz = {
    principal: { id: PRINCIPAL, kind: "human", orgId: ORG, workspaceId: WS },
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [],
  };
  mocks.fetchAuthz.mockClear();
  mocks.scopes = [];
});

describe("holdsCapability", () => {
  it("holds when one of the user's roles grants the capability", async () => {
    mocks.authz.roles = [role("rol-reviewers")];
    mocks.authz.roleGrants = [grant("rol-reviewers", "allow")];

    await expect(holds()).resolves.toBe(true);
    expect(mocks.scopes).toEqual([{ orgId: ORG, workspaceId: WS }]);
    expect(mocks.fetchAuthz).toHaveBeenCalledWith({
      userId: USER,
      apiKeyId: null,
      orgId: ORG,
      workspaceId: WS,
      capability: CAPABILITY.name,
    });
  });

  it("does not hold when no grant names the capability, because its default is deny", async () => {
    mocks.authz.roles = [role("rol-reviewers")];
    mocks.authz.roleGrants = [
      { roleId: "rol-reviewers", capabilityId: "merge_context_pr", effect: "allow" },
    ];

    await expect(holds()).resolves.toBe(false);
  });

  it("does not hold when the grant is on a role the user is not in", async () => {
    mocks.authz.roles = [role("rol-reviewers", { principalIds: ["prn-other"] })];
    mocks.authz.roleGrants = [grant("rol-reviewers", "allow")];

    await expect(holds()).resolves.toBe(false);
  });

  it("holds for the system org Owner, whom no grant names", async () => {
    mocks.authz.roles = [
      role("rol-owner", { name: "Owner", isSystemDefault: true }),
    ];

    await expect(holds()).resolves.toBe(true);
  });

  it("does not hold for a custom role named Owner", async () => {
    mocks.authz.roles = [role("rol-fake-owner", { name: "Owner" })];

    await expect(holds()).resolves.toBe(false);
  });

  it("does not hold when another of the user's roles denies it", async () => {
    mocks.authz.roles = [role("rol-reviewers"), role("rol-restricted")];
    mocks.authz.roleGrants = [
      grant("rol-reviewers", "allow"),
      grant("rol-restricted", "deny"),
    ];

    await expect(holds()).resolves.toBe(false);
  });

  it("does not hold a grant that asks for approval, because no approval runs in a handler", async () => {
    mocks.authz.roles = [role("rol-reviewers")];
    mocks.authz.roleGrants = [grant("rol-reviewers", "require_approval")];

    await expect(holds()).resolves.toBe(false);
  });

  it("does not hold for a user with no IAM principal", async () => {
    mocks.authz.principal = null;
    mocks.authz.roles = [role("rol-reviewers")];
    mocks.authz.roleGrants = [grant("rol-reviewers", "allow")];

    await expect(holds()).resolves.toBe(false);
  });

  it("reads the org scope for the org-only workspace", async () => {
    mocks.authz.roles = [role("rol-reviewers")];
    mocks.authz.roleGrants = [grant("rol-reviewers", "allow")];

    await expect(
      holdsCapability(
        CAPABILITY,
        { orgId: ORG, workspaceId: ORG_ONLY_WORKSPACE_ID },
        USER,
      ),
    ).resolves.toBe(true);
  });
});
