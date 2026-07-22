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
    /** Test-only: how many selects ran (3rd = the delegator lookup). */
    __selectCount: () => call,
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

  it("warns when no initiating human is supplied — the sentinel must never be silent", async () => {
    // Regression guard. A machine-initiated run (the A2A bridge with no
    // ctx.userId, or a v1 delegated run whose optional delegation.userId is
    // absent) used to fall back to the agent's creator and execute with that
    // human's ceiling; it now resolves to the unprivileged sentinel and can
    // materialize no capability tools. That is intended, but it went out
    // unlogged, which makes a correctly-denied run look identical to a broken
    // one. This asserts the operator-visible signal exists.
    mocks.loggerWarn.mockClear();
    mocks.dbFn.mockReturnValue(buildDbMock({}));

    const result = await resolveAgentRunAuthzContext({
      ...BASE,
      initiatingUserId: null,
    });

    expect(result?.humanPrincipal).toBeNull();
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn.mock.calls[0]?.[1]).toContain(
      "no initiating human supplied",
    );
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

  // ── The initiating user — Agent RBAC Phase 2b (RunSpec delegation.userId) ─
  // The V1 delegated path threads `delegation.userId` in as
  // `initiatingUserId`. These cases pin the QUERY COUNT, which is the only
  // way to prove the creator is never consulted: a creator fallback would
  // show up as a fourth select (or a third where there should be two).

  it("resolves the delegator from initiatingUserId even when the agent principal carries NO parentUserId", async () => {
    // Pre-Phase-2b behavior: parentUserId null ⇒ humanPrincipal null, no third
    // query. With an initiating user, the delegator lookup MUST still run —
    // the agent row's own parentUserId is irrelevant to it either way.
    const dbMock = buildDbMock({
      agentPrincipal: [
        {
          id: "prn_agent",
          kind: "agent",
          orgId: "org_1",
          workspaceId: "ws_1",
          parentUserId: null,
          status: "active",
        },
      ],
    });
    mocks.dbFn.mockReturnValue(dbMock);

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
      initiatingUserId: "usr_invoker",
    });

    expect(result?.humanPrincipal).toMatchObject({
      id: "prn_initiator",
      kind: "human",
    });
    expect(dbMock.__selectCount()).toBe(3);
  });

  it("fails closed (humanPrincipal null) when the initiating user has no principal — never falls back to the creator", async () => {
    // The agent's creator HAS a resolvable principal in this fixture, but the
    // initiating user does not: the third query returns no rows and the
    // resolver must NOT retry with the creator (a missing delegator never
    // widens access — the sentinel ceiling applies downstream).
    const dbMock = buildDbMock({ humanPrincipal: [] });
    mocks.dbFn.mockReturnValue(dbMock);

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
      initiatingUserId: "usr_without_principal",
    });

    expect(result?.humanPrincipal).toBeNull();
    // Exactly one delegator lookup — no creator-fallback second query.
    expect(dbMock.__selectCount()).toBe(3);
  });

  it("skips the delegator lookup entirely when no initiating user is supplied, even with a creator on the row", async () => {
    const dbMock = buildDbMock({
      agentPrincipal: [
        {
          id: "prn_agent",
          kind: "agent",
          orgId: "org_1",
          workspaceId: "ws_1",
          // A creator IS recorded — and is still never consulted.
          parentUserId: CREATOR_USER,
          status: "active",
        },
      ],
    });
    mocks.dbFn.mockReturnValue(dbMock);

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
      initiatingUserId: null,
    });

    expect(result?.humanPrincipal).toBeNull();
    expect(dbMock.__selectCount()).toBe(2);
  });
});
