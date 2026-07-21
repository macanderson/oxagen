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
});
