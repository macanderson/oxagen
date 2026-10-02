/**
 * The workspace Owner and Admin rule in `assertCallerRole`, walked over every
 * registered capability (#5228).
 *
 * `assertCallerRole` is the older handler gate: it reads the membership
 * columns (`org_users.role`, `workspace_users.role`) rather than the IAM role
 * assignments. Each walk calls it once per capability the registry holds,
 * with a person who holds no org role:
 *
 *   - The workspace's Owner or Admin passes every capability that acts inside
 *     the workspace, on that workspace.
 *   - On an org-level capability they get exactly what the contract's own
 *     grants gave before, and on another workspace they are refused.
 *   - A workspace Member or Viewer gets exactly the decision they got before.
 *
 * `decisionBefore` is the gate's logic as it stood before #5228, copied from
 * it. A contract that grants no role at all is refused for everyone, before
 * and after, and is left out of the "passes" walk.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCapabilities,
  type CapabilityContext,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import { actsInWorkspace } from "@oxagen/oxagen/iam";

/** The roles one person holds, by membership column. */
type Membership = { org: string | null; workspace: Record<string, string> };

const state = vi.hoisted(() => ({
  membership: { org: null, workspace: {} } as {
    org: string | null;
    workspace: Record<string, string>;
  },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  /** Whether a drizzle SQL tree binds `value` as a parameter. */
  const binds = (node: unknown, value: string, seen = new Set<unknown>()): boolean => {
    if (node === value) return true;
    if (typeof node !== "object" || node === null || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((n) => binds(n, value, seen));
    if ("queryChunks" in node) return binds(node.queryChunks, value, seen);
    if ("value" in node) return binds(node.value, value, seen);
    return false;
  };
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: (table: unknown) => ({
            where: (where: unknown) => ({
              limit: async () => {
                if (table === real.schema.orgUsers) {
                  return state.membership.org === null
                    ? []
                    : [{ role: state.membership.org }];
                }
                const ws = Object.keys(state.membership.workspace).find((id) =>
                  binds(where, id),
                );
                const role =
                  ws === undefined ? undefined : state.membership.workspace[ws];
                return role === undefined ? [] : [{ role }];
              },
            }),
          }),
        }),
      }),
  };
});

const { assertCallerRole, permittedRoles } = await import(
  "./capability-role-guard"
);

const ORG = "00000000-0000-4000-8000-00000000a001";
const WS_A = "00000000-0000-4000-8000-00000000b001";
const WS_B = "00000000-0000-4000-8000-00000000b002";

function ctxOn(workspaceId: string): CapabilityContext {
  return {
    orgId: ORG,
    workspaceId,
    userId: "00000000-0000-4000-8000-00000000c001",
    apiKeyId: null,
    requestId: "req_walk",
    surface: "api",
    messageId: null,
  };
}

async function passes(
  cap: CapabilityDeclaration,
  workspaceId: string,
): Promise<boolean> {
  try {
    await assertCallerRole(cap, ctxOn(workspaceId));
    return true;
  } catch {
    return false;
  }
}

/** The gate's decision before #5228, copied from it. */
function decisionBefore(
  cap: CapabilityDeclaration,
  membership: Membership,
  workspaceId: string,
): boolean {
  const permitted = permittedRoles(cap);
  if (permitted.org.size === 0 && permitted.workspace.size === 0) return false;
  const org = membership.org?.toLowerCase() ?? null;
  if (permitted.org.size > 0 && org !== null && permitted.org.has(org)) {
    return true;
  }
  const ws = membership.workspace[workspaceId]?.toLowerCase() ?? null;
  return permitted.workspace.size > 0 && ws !== null && permitted.workspace.has(ws);
}

const grantsSomeRole = (cap: CapabilityDeclaration) => {
  const permitted = permittedRoles(cap);
  return permitted.org.size > 0 || permitted.workspace.size > 0;
};

const every = listCapabilities();
const workspaceCapabilities = every.filter((cap) => actsInWorkspace(cap));
const orgCapabilities = every.filter((cap) => !actsInWorkspace(cap));

beforeEach(() => {
  state.membership = { org: null, workspace: {} };
});

describe("the walk covers the registry", () => {
  it("walks both workspace and org-level capabilities", () => {
    expect(workspaceCapabilities.length).toBeGreaterThan(200);
    expect(orgCapabilities.length).toBeGreaterThan(20);
  });
});

// The column is written in both casings, so both are walked.
describe.each(["owner", "Admin"])(
  "a workspace member whose role is %s, with no org role",
  (role) => {
    const onA: Membership = { org: null, workspace: { [WS_A]: role } };

    it("passes every workspace capability that grants any role, on that workspace", async () => {
      state.membership = onA;
      const refused: string[] = [];
      for (const cap of workspaceCapabilities.filter(grantsSomeRole)) {
        if (!(await passes(cap, WS_A))) refused.push(cap.name);
      }
      expect(refused).toEqual([]);
    });

    it("gains nothing on an org-level capability (negative)", async () => {
      state.membership = onA;
      const changed: string[] = [];
      for (const cap of orgCapabilities) {
        if ((await passes(cap, WS_A)) !== decisionBefore(cap, onA, WS_A)) {
          changed.push(cap.name);
        }
      }
      expect(changed).toEqual([]);
    });

    it("is refused every capability on another workspace (negative)", async () => {
      state.membership = onA;
      const passed: string[] = [];
      for (const cap of every) {
        if (await passes(cap, WS_B)) passed.push(cap.name);
      }
      expect(passed).toEqual([]);
    });
  },
);

describe("a Member or Viewer gets the decision they got before", () => {
  it.each(["member", "Viewer"])("%s", async (role) => {
    const onA: Membership = { org: "member", workspace: { [WS_A]: role } };
    state.membership = onA;
    const changed: string[] = [];
    for (const cap of every) {
      if ((await passes(cap, WS_A)) !== decisionBefore(cap, onA, WS_A)) {
        changed.push(cap.name);
      }
    }
    expect(changed).toEqual([]);
  });
});

describe("an agent run gets no workspace rule (negative)", () => {
  it("refuses the workspace's Owner on a run they are not otherwise granted", async () => {
    state.membership = { org: null, workspace: { [WS_A]: "owner" } };
    const cap = workspaceCapabilities.find(
      (c) => grantsSomeRole(c) && !decisionBefore(c, state.membership, WS_A),
    )!;
    await expect(
      assertCallerRole(cap, {
        ...ctxOn(WS_A),
        agentRun: {} as CapabilityContext["agentRun"],
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});
