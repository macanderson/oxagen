// check-iam.workspace-authority.test.ts — the workspace Owner and Admin rule
// in the kernel's IAM check for an Enterprise org, walked over every
// registered capability (#5228).
//
// An Enterprise org runs the full resolver, so a role is decided by the role
// grants seeded from each contract's `defaultRoles` and by rule 7.6. Each walk
// calls `checkIAM` once per registered capability, with the inputs the kernel
// passes (`actsInWorkspace` from the contract), against role grants seeded the
// way bootstrapOrgIAM seeds them:
//
//   - A workspace Owner or Admin with no org role is allowed every capability
//     that acts inside the workspace.
//   - The same person gains nothing from the rule on an org-level
//     capability, and is refused every one whose contract grants no
//     workspace role and does not allow by default. On another workspace and
//     on an org-only call they get exactly what a person with no role gets.
//   - Member and Viewer, and each org role, get the same outcome and the same
//     deciding rule with the rule's inputs present as without them.
//
// `fetchAuthz` is replaced by a double that answers as its queries do: a
// workspace role counts on the call's workspace only, an org role counts
// everywhere, and `workspaceRoleIds` lists the roles assigned on the call's
// workspace itself.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCapabilities,
  ORG_ONLY_WORKSPACE_ID,
  type CapabilityContext,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import {
  actsInWorkspace,
  type Role,
  type RoleGrant,
} from "@oxagen/oxagen/iam";
import type { AuthzData, FetchAuthzArgs } from "./fetch-authz";

const mocks = vi.hoisted(() => ({
  fetchAuthz: vi.fn<(args: FetchAuthzArgs) => Promise<AuthzData>>(),
  emitAudit: vi.fn(async () => undefined),
}));

vi.mock("./fetch-authz", () => ({ fetchAuthz: mocks.fetchAuthz }));
vi.mock("./emit-audit", () => ({ emitAudit: mocks.emitAudit }));

import { checkIAM } from "./check-iam";

const ORG = "00000000-0000-4000-8000-00000000a001";
const WS_A = "00000000-0000-4000-8000-00000000b001";
const WS_B = "00000000-0000-4000-8000-00000000b002";
const USER = "00000000-0000-4000-8000-00000000c001";
const PRN = "00000000-0000-4000-8000-00000000d001";

const ORG_ROLES = ["Owner", "Admin", "Compliance", "Billing"] as const;
const WORKSPACE_ROLES = ["Owner", "Admin", "Member", "Viewer"] as const;

const roleId = (scope: "org" | "workspace", name: string) =>
  `rol_${scope}_${name.toLowerCase()}`;

/** The roles one person holds: org-wide, and per workspace. */
type Holding = { org: string[]; workspace: Record<string, string[]> };

/**
 * The role grants bootstrapOrgIAM seeds for one capability: one row per
 * system role its contract's `defaultRoles` names, with that effect.
 */
function seededGrants(cap: CapabilityDeclaration): RoleGrant[] {
  const rows: RoleGrant[] = [];
  const org = cap.defaultRoles.org as Record<string, string | undefined>;
  const ws = cap.defaultRoles.workspace as Record<string, string | undefined>;
  for (const name of ORG_ROLES) {
    const effect = org[name];
    if (effect) {
      rows.push({
        roleId: roleId("org", name),
        capabilityId: cap.name,
        effect: effect as RoleGrant["effect"],
      });
    }
  }
  for (const name of WORKSPACE_ROLES) {
    const effect = ws[name];
    if (effect) {
      rows.push({
        roleId: roleId("workspace", name),
        capabilityId: cap.name,
        effect: effect as RoleGrant["effect"],
      });
    }
  }
  return rows;
}

const byName = new Map(listCapabilities().map((cap) => [cap.name, cap]));

/** Answer fetchAuthz as its queries would for this holding. */
function hold(holding: Holding, opts: { pinned: boolean } = { pinned: true }) {
  mocks.fetchAuthz.mockImplementation(async (args) => {
    const heldHere = holding.workspace[args.workspaceId] ?? [];
    const roles: Role[] = [
      ...ORG_ROLES.map((name) => ({
        id: roleId("org", name),
        name,
        scopeKind: "org" as const,
        orgId: ORG,
        isSystemDefault: true,
        principalIds: holding.org.includes(name) ? [PRN] : [],
      })),
      ...WORKSPACE_ROLES.map((name) => ({
        id: roleId("workspace", name),
        name,
        scopeKind: "workspace" as const,
        orgId: ORG,
        isSystemDefault: true,
        principalIds: heldHere.includes(name) ? [PRN] : [],
      })),
    ];
    const cap = byName.get(args.capability);
    return {
      principal: { id: PRN, kind: "human", orgId: ORG, workspaceId: null },
      grants: [],
      roles,
      roleGrants: cap ? seededGrants(cap) : [],
      policies: [],
      apiKeyPurpose: null,
      // Without `pinned`, the shape fetchAuthz returned before #5228.
      ...(opts.pinned
        ? {
            workspaceRoleIds: heldHere.map((name) =>
              roleId("workspace", name),
            ),
          }
        : {}),
    };
  });
}

function ctxOn(workspaceId: string): CapabilityContext {
  return {
    orgId: ORG,
    workspaceId,
    userId: USER,
    apiKeyId: null,
    requestId: "req_walk",
    surface: "api",
    messageId: null,
    planTier: "enterprise",
  };
}

/** Outcome and deciding rule, as the kernel reads them. */
async function decide(
  cap: CapabilityDeclaration,
  workspaceId: string,
  opts: { kernelInputs: boolean } = { kernelInputs: true },
): Promise<string> {
  const { result } = await checkIAM({
    capability: cap.name,
    ctx: ctxOn(workspaceId),
    defaultEffect: cap.defaultEffect,
    rawInputJson: "{}",
    ...(opts.kernelInputs ? { actsInWorkspace: actsInWorkspace(cap) } : {}),
  });
  return `${result.outcome} by ${result.trace.decidedBy.rule}`;
}

const every = listCapabilities();
const workspaceCapabilities = every.filter((cap) => actsInWorkspace(cap));
const orgCapabilities = every.filter((cap) => !actsInWorkspace(cap));
const NOBODY: Holding = { org: [], workspace: {} };

beforeEach(() => {
  mocks.fetchAuthz.mockReset();
});

describe("the walk covers the registry", () => {
  it("walks both workspace and org-level capabilities", () => {
    expect(workspaceCapabilities.length).toBeGreaterThan(200);
    expect(orgCapabilities.length).toBeGreaterThan(20);
  });
});

describe.each(["Owner", "Admin"])(
  "an Enterprise org's workspace %s with no org role",
  (role) => {
    const onA: Holding = { org: [], workspace: { [WS_A]: [role] } };

    it("is allowed every workspace capability on that workspace", async () => {
      hold(onA);
      const refused: string[] = [];
      for (const cap of workspaceCapabilities) {
        const decision = await decide(cap, WS_A);
        if (!decision.startsWith("allow")) {
          refused.push(`${cap.name}: ${decision}`);
        }
      }
      expect(refused).toEqual([]);
    });

    it("gains nothing from rule 7.6 on any org-level capability (negative)", async () => {
      // Same holding, with and without the rule's inputs. A few org-level
      // contracts grant workspace roles themselves; the person keeps exactly
      // what those grants gave, and rule 7.6 never decides.
      const differs: string[] = [];
      for (const cap of orgCapabilities) {
        hold(onA, { pinned: false });
        const before = await decide(cap, WS_A, { kernelInputs: false });
        hold(onA);
        const after = await decide(cap, WS_A);
        if (after !== before || after.endsWith("7.6:workspace_full_access")) {
          differs.push(`${cap.name}: ${before} -> ${after}`);
        }
      }
      expect(differs).toEqual([]);
    });

    it("is refused every org-level capability whose contract grants no workspace role (negative)", async () => {
      hold(onA);
      const allowed: string[] = [];
      for (const cap of orgCapabilities) {
        const grantsWorkspace = Object.values(cap.defaultRoles.workspace).some(
          (effect) => effect !== undefined,
        );
        if (grantsWorkspace || cap.defaultEffect === "allow") continue;
        const decision = await decide(cap, WS_A);
        if (decision.startsWith("allow")) allowed.push(`${cap.name}: ${decision}`);
      }
      expect(allowed).toEqual([]);
    });

    it("gets no more than a person with no role on another workspace or an org-only call (negative)", async () => {
      const differs: string[] = [];
      for (const cap of every) {
        for (const workspaceId of [WS_B, ORG_ONLY_WORKSPACE_ID]) {
          hold(NOBODY);
          const nobody = await decide(cap, workspaceId);
          hold(onA);
          const person = await decide(cap, workspaceId);
          if (person !== nobody) {
            differs.push(`${cap.name} on ${workspaceId}: ${nobody} -> ${person}`);
          }
        }
      }
      expect(differs).toEqual([]);
    });
  },
);

describe("everyone else gets the decision they got before", () => {
  // Before #5228 the kernel passed no `actsInWorkspace` and fetchAuthz
  // returned no `workspaceRoleIds`, so rule 7.6 could not run. Each holding
  // below gets the same outcome and deciding rule both ways, on every
  // registered capability.
  const holdings: Record<string, Holding> = {
    "workspace Member": { org: [], workspace: { [WS_A]: ["Member"] } },
    "workspace Viewer": { org: [], workspace: { [WS_A]: ["Viewer"] } },
    "no role": NOBODY,
    ...Object.fromEntries(
      ORG_ROLES.map((orgRole) => [
        `org ${orgRole}`,
        { org: [orgRole], workspace: { [WS_A]: ["Member"] } },
      ]),
    ),
  };

  it.each(Object.keys(holdings))("%s", async (label) => {
    const holding = holdings[label]!;
    const changed: string[] = [];
    for (const cap of every) {
      hold(holding, { pinned: false });
      const before = await decide(cap, WS_A, { kernelInputs: false });
      hold(holding);
      const after = await decide(cap, WS_A);
      if (after !== before) changed.push(`${cap.name}: ${before} -> ${after}`);
    }
    expect(changed).toEqual([]);
  });
});
