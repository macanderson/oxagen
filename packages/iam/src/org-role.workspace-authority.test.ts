// org-role.workspace-authority.test.ts — the workspace Owner and Admin rule
// in the handler's role gate, walked over every registered capability (#5228).
//
// Mac decided on 2026-10-02 that a workspace's Owner and Admin can do
// everything in that workspace, and nothing outside it. `assertOrgRole` is the
// gate a handler runs itself, so each walk below calls it once per registered
// capability, as the kernel would hand a handler the context:
//
//   - A workspace Owner or Admin with no org role passes every capability
//     that acts inside the workspace, under the strictest gate a handler
//     writes (org Owner only) and under the gate its contract declares.
//   - The same person is refused every org-level capability, every
//     capability on another workspace, and every capability on an org-only
//     call. Where an org-level contract grants a workspace role itself, the
//     person gets that grant and nothing more.
//   - Member and Viewer, and every org role, get exactly the decision the
//     gate made before #5228. `decisionBefore` is that gate's logic, copied
//     from it as it stood, and the walk compares the two on every capability.
//
// The list is `listCapabilities()` after importing @oxagen/oxagen, which
// registers every contract. It is never a hand-picked list.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isHandlerError,
  listCapabilities,
  ORG_ONLY_WORKSPACE_ID,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import { actsInWorkspace } from "@oxagen/oxagen/iam";

const mocks = vi.hoisted(() => ({
  withOrgDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withOrgDb: mocks.withOrgDb };
});

import { schema } from "@oxagen/database";
import {
  assertOrgRole,
  workspaceAuthorityRole,
  type OrgRoleActor,
  type OrgRoleRequirement,
} from "./org-role";

const ORG = "00000000-0000-4000-8000-00000000a001";
const WS_A = "00000000-0000-4000-8000-00000000b001";
const WS_B = "00000000-0000-4000-8000-00000000b002";
const USER = "00000000-0000-4000-8000-00000000c001";

/** Whether a drizzle SQL tree binds `value` as a parameter. */
function binds(node: unknown, value: string, seen = new Set<unknown>()): boolean {
  if (node === value) return true;
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((n) => binds(n, value, seen));
  if ("queryChunks" in node) return binds(node.queryChunks, value, seen);
  if ("value" in node) return binds(node.value, value, seen);
  return false;
}

/**
 * Which assignments a role lookup asked for: `null` for org-wide, else the
 * workspace id it pins. The lookup binds the role's scope kind, and a
 * workspace lookup binds the workspace id too.
 */
function scopeOf(where: unknown, known: readonly string[]): string | null {
  if (!binds(where, "workspace")) return null;
  return known.find((id) => binds(where, id)) ?? "unknown-workspace";
}

/** The roles one person holds: org-wide, and per workspace. */
type Holding = {
  org: string[];
  workspace: Record<string, string[]>;
};

function hold(holding: Holding): void {
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.principals) {
          return {
            where: () => ({ limit: async () => [{ id: "prn_1" }] }),
          };
        }
        return {
          innerJoin: () => ({
            where: (where: unknown) => ({
              limit: async () => {
                const scope = scopeOf(where, [
                  ...Object.keys(holding.workspace),
                  WS_A,
                  WS_B,
                  ORG_ONLY_WORKSPACE_ID,
                ]);
                const names =
                  scope === null
                    ? holding.org
                    : (holding.workspace[scope] ?? []);
                return names.map((roleName) => ({ roleName }));
              },
            }),
          }),
        };
      },
    }),
  };
  mocks.withOrgDb.mockImplementation((fn: (t: unknown) => unknown) =>
    Promise.resolve(fn(tx)),
  );
}

/** The role names a contract grants `allow`, as the handler gates read them. */
function allowed(
  grants: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(grants)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

/** The gate a handler derives from its contract (`contractRoleRequirement`). */
function contractGate(cap: CapabilityDeclaration): OrgRoleRequirement {
  const workspace = allowed(cap.defaultRoles.workspace);
  return workspace.length > 0
    ? { org: allowed(cap.defaultRoles.org), workspace }
    : { org: allowed(cap.defaultRoles.org) };
}

/** The strictest gate a handler writes: org Owner, nothing else. */
const ORG_OWNER_ONLY: OrgRoleRequirement = { org: ["Owner"] };

/** The role that passed, or null when the gate refused with `forbidden`. */
async function decide(
  actor: OrgRoleActor,
  required: OrgRoleRequirement,
): Promise<string | null> {
  try {
    return await assertOrgRole(actor, required);
  } catch (err) {
    if (isHandlerError(err) && err.code === "forbidden") return null;
    throw err;
  }
}

/**
 * The decision `assertOrgRole` made before #5228, copied from it: an org role
 * the gate names, else a workspace role it names on the call's workspace, the
 * most privileged first. It has no workspace Owner and Admin rule.
 */
function decisionBefore(
  holding: Holding,
  workspaceId: string,
  required: OrgRoleRequirement,
): string | null {
  const precedence = ["Owner", "Admin"];
  const pick = (names: string[]) =>
    precedence.find((n) => names.includes(n)) ?? names[0] ?? null;
  const org = pick(holding.org.filter((n) => required.org.includes(n)));
  if (org !== null) return org;
  if (required.workspace && workspaceId) {
    const accepted = required.workspace;
    return pick(
      (holding.workspace[workspaceId] ?? []).filter((n) =>
        accepted.includes(n),
      ),
    );
  }
  return null;
}

const every = listCapabilities();
const workspaceCapabilities = every.filter((cap) => actsInWorkspace(cap));
const orgCapabilities = every.filter((cap) => !actsInWorkspace(cap));

function actor(cap: CapabilityDeclaration, workspaceId: string): OrgRoleActor {
  return { orgId: ORG, workspaceId, userId: USER, invokedCapability: cap.name };
}

beforeEach(() => {
  mocks.withOrgDb.mockReset();
});

describe("the walk covers the registry", () => {
  it("walks both workspace and org-level capabilities", () => {
    // Guards against a vacuous walk: an empty registry passes every loop.
    expect(workspaceCapabilities.length).toBeGreaterThan(200);
    expect(orgCapabilities.length).toBeGreaterThan(20);
    expect(workspaceCapabilities.map((c) => c.name)).toContain("import_tools");
    expect(orgCapabilities.map((c) => c.name)).toContain("purchase_credits");
  });
});

describe.each(["Owner", "Admin"])("a workspace %s with no org role", (role) => {
  const onA: Holding = { org: [], workspace: { [WS_A]: [role] } };

  it("passes every workspace capability's role check on that workspace", async () => {
    hold(onA);
    const refused: string[] = [];
    for (const cap of workspaceCapabilities) {
      for (const gate of [ORG_OWNER_ONLY, contractGate(cap)]) {
        if ((await decide(actor(cap, WS_A), gate)) === null) {
          refused.push(cap.name);
        }
      }
    }
    expect(refused).toEqual([]);
  });

  it("is refused every org-level capability (negative)", async () => {
    hold(onA);
    const passed: string[] = [];
    for (const cap of orgCapabilities) {
      if ((await decide(actor(cap, WS_A), ORG_OWNER_ONLY)) !== null) {
        passed.push(cap.name);
      }
    }
    expect(passed).toEqual([]);
  });

  it("gains nothing from the rule on an org-level capability's own gate (negative)", async () => {
    // A few org-level contracts grant workspace roles themselves, such as
    // get_org_settings for every member. Under the contract's own gate the
    // person gets exactly what that grant gave before #5228, and no more.
    hold(onA);
    const changed: string[] = [];
    for (const cap of orgCapabilities) {
      const gate = contractGate(cap);
      const after = await decide(actor(cap, WS_A), gate);
      const before = decisionBefore(onA, WS_A, gate);
      if (after !== before) changed.push(`${cap.name}: ${before} -> ${after}`);
    }
    expect(changed).toEqual([]);
  });

  it("is refused every capability on another workspace (negative)", async () => {
    hold(onA);
    const passed: string[] = [];
    for (const cap of every) {
      for (const gate of [ORG_OWNER_ONLY, contractGate(cap)]) {
        if ((await decide(actor(cap, WS_B), gate)) !== null) {
          passed.push(cap.name);
        }
      }
    }
    expect(passed).toEqual([]);
  });

  it("is refused every capability on an org-only call (negative)", async () => {
    // Even a person holding the role on the sentinel id itself gains nothing.
    hold({
      org: [],
      workspace: { [WS_A]: [role], [ORG_ONLY_WORKSPACE_ID]: [role] },
    });
    const passed: string[] = [];
    for (const cap of every) {
      if ((await decide(actor(cap, ORG_ONLY_WORKSPACE_ID), ORG_OWNER_ONLY)) !== null) {
        passed.push(cap.name);
      }
    }
    expect(passed).toEqual([]);
  });

  it("returns the workspace role that passed", async () => {
    hold(onA);
    const cap = workspaceCapabilities[0]!;
    await expect(assertOrgRole(actor(cap, WS_A), ORG_OWNER_ONLY)).resolves.toBe(
      role,
    );
  });
});

describe("what turns the rule off", () => {
  const owner: Holding = { org: [], workspace: { [WS_A]: ["Owner"] } };
  const cap = () =>
    workspaceCapabilities.find((c) => c.name === "import_tools")!;

  it("an actor the kernel did not stamp with a capability (negative)", async () => {
    hold(owner);
    const { invokedCapability: _omitted, ...bare } = actor(cap(), WS_A);
    expect(await decide(bare, ORG_OWNER_ONLY)).toBeNull();
  });

  it("a capability name nothing registered (negative)", async () => {
    hold(owner);
    expect(
      await decide(
        { ...actor(cap(), WS_A), invokedCapability: "no_such_capability" },
        ORG_OWNER_ONLY,
      ),
    ).toBeNull();
  });

  it("an agent run, or a deployed agent's pre-run call (negative)", async () => {
    hold(owner);
    expect(
      await decide({ ...actor(cap(), WS_A), agentRun: {} }, ORG_OWNER_ONLY),
    ).toBeNull();
    expect(
      await decide(
        { ...actor(cap(), WS_A), deployedAgentInvocation: {} },
        ORG_OWNER_ONLY,
      ),
    ).toBeNull();
  });

  it("a gate that names its roles only (negative)", async () => {
    hold(owner);
    expect(
      await decide(actor(cap(), WS_A), { org: ["Owner"], namedRolesOnly: true }),
    ).toBeNull();
  });

  it("no signed-in user (negative)", async () => {
    hold(owner);
    expect(
      await decide({ ...actor(cap(), WS_A), userId: null }, ORG_OWNER_ONLY),
    ).toBeNull();
  });
});

describe("workspaceAuthorityRole, for gates that read the org role themselves", () => {
  const cap = () =>
    workspaceCapabilities.find((c) => c.name === "create_tacho_enrollment")!;

  it.each(["Owner", "Admin"])("names the workspace %s", async (role) => {
    hold({ org: [], workspace: { [WS_A]: [role] } });
    await expect(workspaceAuthorityRole(actor(cap(), WS_A), USER)).resolves.toBe(
      role,
    );
  });

  it("names nothing for a Member, on another workspace, or on an org-level capability (negative)", async () => {
    hold({ org: [], workspace: { [WS_A]: ["Member"], [WS_B]: [] } });
    expect(await workspaceAuthorityRole(actor(cap(), WS_A), USER)).toBeNull();
    hold({ org: [], workspace: { [WS_A]: ["Owner"] } });
    expect(await workspaceAuthorityRole(actor(cap(), WS_B), USER)).toBeNull();
    const orgLevel = orgCapabilities.find((c) => c.name === "create_api_key")!;
    expect(await workspaceAuthorityRole(actor(orgLevel, WS_A), USER)).toBeNull();
  });

  it("reads nothing when the rule cannot apply", async () => {
    hold({ org: [], workspace: { [WS_A]: ["Owner"] } });
    const { invokedCapability: _omitted, ...bare } = actor(cap(), WS_A);
    expect(await workspaceAuthorityRole(bare, USER)).toBeNull();
    expect(mocks.withOrgDb).not.toHaveBeenCalled();
  });
});

describe("everyone else gets the decision they got before", () => {
  // Member and Viewer on the call's workspace, and each org role beside a
  // workspace Member role. Under the contract's own gate and under the
  // strictest one, on every registered capability, the gate decides exactly
  // as `decisionBefore` does.
  const holdings: Record<string, Holding> = {
    "workspace Member": { org: [], workspace: { [WS_A]: ["Member"] } },
    "workspace Viewer": { org: [], workspace: { [WS_A]: ["Viewer"] } },
    "no role": { org: [], workspace: {} },
    ...Object.fromEntries(
      ["Owner", "Admin", "Billing", "Compliance"].map((orgRole) => [
        `org ${orgRole}`,
        { org: [orgRole], workspace: { [WS_A]: ["Member"] } },
      ]),
    ),
  };

  it.each(Object.keys(holdings))("%s", async (label) => {
    const holding = holdings[label]!;
    hold(holding);
    const changed: string[] = [];
    for (const cap of every) {
      for (const gate of [ORG_OWNER_ONLY, contractGate(cap)]) {
        const after = await decide(actor(cap, WS_A), gate);
        const before = decisionBefore(holding, WS_A, gate);
        if (after !== before) {
          changed.push(`${cap.name}: ${before} -> ${after}`);
        }
      }
    }
    expect(changed).toEqual([]);
  });
});
