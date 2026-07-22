// agent-run-context.test.ts — unit tests for resolveAgentRunAuthzContext()
// (Agent RBAC docs/specs/agent-rbac/spec.md §3.1; run-evidence Task 5).
//
// The headline property: the run's human side is the AUTHENTICATED INITIATING
// principal, never the agent's creator (`principals.parent_user_id`). Binding
// the creator would let anyone who can trigger an agent borrow the creator's
// ceiling.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), loggerWarn: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mocks.dbFn()),
  };
});

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: mocks.loggerWarn, info: vi.fn() },
}));

import { resolveAgentRunAuthzContext } from "./agent-run-context";

const CREATOR_USER = "usr_creator";
const INITIATING_USER = "usr_initiator";

/**
 * Query order inside resolveAgentRunAuthzContext:
 *   1: agents (principalId, limit 1)
 *   2: principals — the agent's own principal (limit 1)
 *   3: principals — the INITIATING human's principal (limit 1, only when an
 *      initiatingUserId was supplied)
 *
 * `selectCalls()` proves query 3 is skipped entirely when there is no
 * initiating user, rather than silently falling back to the creator.
 */
function buildDbMock(overrides: {
  agent?: unknown[];
  agentPrincipal?: unknown[];
  humanPrincipal?: unknown[];
}) {
  const agent = overrides.agent ?? [{ principalId: "prn_agent" }];
  const agentPrincipal = overrides.agentPrincipal ?? [
    {
      id: "prn_agent",
      kind: "agent",
      orgId: "org_1",
      workspaceId: "ws_1",
      status: "active",
    },
  ];
  const humanPrincipal = overrides.humanPrincipal ?? [
    {
      id: "prn_initiator",
      orgId: "org_1",
      workspaceId: null,
      status: "active",
    },
  ];

  let call = 0;
  const makeChain = (rows: unknown[]) => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });

  return {
    selectCalls: () => call,
    select: () => {
      call++;
      if (call === 1) return makeChain(agent);
      if (call === 2) return makeChain(agentPrincipal);
      if (call === 3) return makeChain(humanPrincipal);
      return makeChain([]);
    },
  };
}

const BASE = {
  orgId: "org_1",
  workspaceId: "ws_1",
  agentId: "agt_1",
  initiatingUserId: INITIATING_USER as string | null,
};

beforeEach(() => vi.clearAllMocks());

describe("resolveAgentRunAuthzContext()", () => {
  it("resolves the agent principal and the AUTHENTICATED initiating human", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}));

    const result = await resolveAgentRunAuthzContext(BASE);

    expect(result?.principalKind).toBe("agent");
    expect(result?.agentPrincipal).toMatchObject({
      id: "prn_agent",
      kind: "agent",
    });
    expect(result?.humanPrincipal).toMatchObject({
      id: "prn_initiator",
      kind: "human",
    });
  });

  it("does NOT query for a human at all when there is no initiating user", async () => {
    const db = buildDbMock({});
    mocks.dbFn.mockReturnValue(db);

    const result = await resolveAgentRunAuthzContext({
      ...BASE,
      initiatingUserId: null,
    });

    // Two queries: the agent and its principal. The creator is never consulted.
    expect(db.selectCalls()).toBe(2);
    expect(result?.humanPrincipal).toBeNull();
  });

  it("ignores the agent's creator: parent_user_id never becomes the ceiling's human side", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        agentPrincipal: [
          {
            id: "prn_agent",
            kind: "agent",
            orgId: "org_1",
            workspaceId: "ws_1",
            // Present on the row, and deliberately unused.
            parentUserId: CREATOR_USER,
            status: "active",
          },
        ],
      }),
    );

    const result = await resolveAgentRunAuthzContext(BASE);
    expect(result?.humanPrincipal?.id).toBe("prn_initiator");
  });

  it("returns null when the agent has no principalId (unknown/pre-provision)", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ agent: [{ principalId: null }] }));
    expect(await resolveAgentRunAuthzContext(BASE)).toBeNull();
  });

  it("returns null when the agent is not found", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ agent: [] }));
    expect(
      await resolveAgentRunAuthzContext({ ...BASE, agentId: "agt_missing" }),
    ).toBeNull();
  });

  it("returns null when the agent's principal has been soft-deleted", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        agentPrincipal: [
          {
            id: "prn_agent",
            kind: "agent",
            orgId: "org_1",
            workspaceId: "ws_1",
            status: "deleted",
          },
        ],
      }),
    );
    expect(await resolveAgentRunAuthzContext(BASE)).toBeNull();
  });

  it("returns null when the agent's principal is SUSPENDED", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        agentPrincipal: [
          {
            id: "prn_agent",
            kind: "agent",
            orgId: "org_1",
            workspaceId: "ws_1",
            status: "suspended",
          },
        ],
      }),
    );
    expect(await resolveAgentRunAuthzContext(BASE)).toBeNull();
  });

  it("resolves humanPrincipal to null (and warns) when the initiating user has no principal", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ humanPrincipal: [] }));

    const result = await resolveAgentRunAuthzContext(BASE);

    expect(result?.principalKind).toBe("agent");
    expect(result?.humanPrincipal).toBeNull();
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("resolves humanPrincipal to null when the initiating user's principal is suspended", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        humanPrincipal: [
          {
            id: "prn_initiator",
            orgId: "org_1",
            workspaceId: null,
            status: "suspended",
          },
        ],
      }),
    );
    const result = await resolveAgentRunAuthzContext(BASE);
    expect(result?.humanPrincipal).toBeNull();
  });
});
