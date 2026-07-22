// agent-run-context.test.ts — unit tests for resolveAgentRunAuthzContext()
// (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.1).

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mocks.dbFn()),
  };
});

import { resolveAgentRunAuthzContext } from "./agent-run-context";

// Query order inside resolveAgentRunAuthzContext:
//   1: agents (principalId, limit 1)
//   2: principals — the agent's own principal (limit 1)
//   3: principals — the human principal via parentUserId (limit 1, only if
//      the agent principal carries a parentUserId)
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
      parentUserId: "usr_1",
      status: "active",
    },
  ];
  const humanPrincipal = overrides.humanPrincipal ?? [
    { id: "prn_human", kind: "human", orgId: "org_1", workspaceId: null },
  ];

  let call = 0;
  const makeChain = (rows: unknown[]) => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });

  return {
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

beforeEach(() => vi.clearAllMocks());

describe("resolveAgentRunAuthzContext()", () => {
  it("resolves both the agent principal and the invoking human principal", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}));

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
    });

    expect(result).not.toBeNull();
    expect(result?.principalKind).toBe("agent");
    expect(result?.agentPrincipal).toMatchObject({
      id: "prn_agent",
      kind: "agent",
    });
    expect(result?.humanPrincipal).toMatchObject({
      id: "prn_human",
      kind: "human",
    });
  });

  it("returns null when the agent has no principalId (unknown/pre-provision)", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ agent: [{ principalId: null }] }));

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
    });

    expect(result).toBeNull();
  });

  it("returns null when the agent is not found", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ agent: [] }));

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_missing",
    });

    expect(result).toBeNull();
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
            parentUserId: "usr_1",
            status: "deleted",
          },
        ],
      }),
    );

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
    });

    expect(result).toBeNull();
  });

  it("resolves humanPrincipal to null when no human principal matches parentUserId", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ humanPrincipal: [] }));

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
    });

    expect(result?.principalKind).toBe("agent");
    expect(result?.agentPrincipal.kind).toBe("agent");
    expect(result?.humanPrincipal).toBeNull();
  });

  // ── invokingUserId — Agent RBAC Phase 2b (RunSpec delegation.userId) ──────
  // When the enqueue surface captured the INVOKING user, the human side of
  // the delegation ceiling is resolved from that user, not from the agent
  // principal's parentUserId (the creator).

  it("resolves the delegator from invokingUserId even when the agent principal carries NO parentUserId", async () => {
    // Pre-change behavior: parentUserId null ⇒ humanPrincipal null, no third
    // query. With invokingUserId, the delegator lookup MUST still run.
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
      invokingUserId: "usr_invoker",
    });

    expect(result?.humanPrincipal).toMatchObject({
      id: "prn_human",
      kind: "human",
    });
    expect(dbMock.__selectCount()).toBe(3);
  });

  it("fails closed (humanPrincipal null) when the invoking user has no principal — never falls back to the creator", async () => {
    // The agent's creator (parentUserId usr_1) HAS a resolvable principal in
    // this fixture, but the invoking user does not: the third query returns
    // no rows and the resolver must NOT retry with the creator (a missing
    // delegator never widens access — sentinel ceiling applies downstream).
    const dbMock = buildDbMock({ humanPrincipal: [] });
    mocks.dbFn.mockReturnValue(dbMock);

    const result = await resolveAgentRunAuthzContext({
      orgId: "org_1",
      workspaceId: "ws_1",
      agentId: "agt_1",
      invokingUserId: "usr_without_principal",
    });

    expect(result?.humanPrincipal).toBeNull();
    // Exactly one delegator lookup — no creator-fallback second query.
    expect(dbMock.__selectCount()).toBe(3);
  });

  it("skips the delegator lookup entirely when neither invokingUserId nor parentUserId exist", async () => {
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
    });

    expect(result?.humanPrincipal).toBeNull();
    expect(dbMock.__selectCount()).toBe(2);
  });
});
