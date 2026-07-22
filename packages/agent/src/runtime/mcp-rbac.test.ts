// mcp-rbac.test.ts — Agent RBAC Phase 4a: run-scope resolution, per-call
// effect decisions, audit emission, and the GLOB PARITY WITNESS that pins
// @oxagen/oxagen/iam's rule matcher to packages/mcp-config's matchGlob (the
// spec §3.7 "do not invent a second matcher" guarantee — this package is the
// one place that depends on BOTH implementations, so the witness lives here).

import { describe, expect, it, vi, beforeEach } from "vitest";

const emitAuditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@oxagen/iam", () => ({
  emitAudit: emitAuditMock,
}));

import { matchGlob } from "@oxagen/mcp-config/permissions";
import {
  createAgentRunResolution,
  evaluateMcpRules,
  type AgentRunIAMContext,
  type ResolveScope,
} from "@oxagen/oxagen/iam";
import {
  decideMcpToolEffect,
  effectiveMcpScopeForRun,
  emitMcpRuleAudit,
  MCP_SCOPE_SENTINEL_CAPABILITY,
} from "./mcp-rbac";
import type { CapabilityContext } from "../types";

const ORG_ID = "org_1";
const WS_ID = "ws_1";

const scope: ResolveScope = {
  kind: "workspace",
  orgId: ORG_ID,
  workspaceId: WS_ID,
};

const ctx: CapabilityContext = {
  orgId: ORG_ID,
  workspaceId: WS_ID,
  userId: "usr_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner",
  messageId: null,
  clientIp: null,
};

function makeAgentRun(
  mcpRules: Array<{ pattern: string; effect: "allow" | "deny" | "ask" }>,
): AgentRunIAMContext {
  const agentRun: AgentRunIAMContext = {
    principalKind: "agent",
    agentPrincipal: {
      id: "prn_agent",
      kind: "agent",
      orgId: ORG_ID,
      workspaceId: WS_ID,
    },
    humanPrincipal: {
      id: "prn_human",
      kind: "human",
      orgId: ORG_ID,
      workspaceId: WS_ID,
    },
    agentId: "agt_1",
    runId: "run_1",
  };
  agentRun.resolution = createAgentRunResolution({
    grants: [
      {
        principalId: "prn_agent",
        capabilityId: MCP_SCOPE_SENTINEL_CAPABILITY,
        scopeKind: "workspace",
        scopeId: WS_ID,
        effect: "allow",
        conditionsJsonb: { resourceScope: { mcp: { rules: mcpRules } } },
        expiresAt: null,
      },
      {
        principalId: "prn_human",
        capabilityId: MCP_SCOPE_SENTINEL_CAPABILITY,
        scopeKind: "workspace",
        scopeId: WS_ID,
        effect: "allow",
        conditionsJsonb: {},
        expiresAt: null,
      },
    ],
    roles: [],
    roleGrants: [],
    policies: [],
  });
  return agentRun;
}

describe("effectiveMcpScopeForRun — one resolution per run", () => {
  it("resolves the run-constant mcp scope through the sentinel when nothing is cached", () => {
    const run = makeAgentRun([{ pattern: "github:*", effect: "deny" }]);
    const resolution = run.resolution!;
    expect(resolution.byCapability.size).toBe(0);
    const mcpScope = effectiveMcpScopeForRun(
      run,
      resolution,
      scope,
      new Date(),
      null,
    );
    expect(mcpScope?.ruleSets).toEqual([
      [{ pattern: "github:*", effect: "deny" }],
    ]);
    // The sentinel resolution was memoized on the run's ONE cache — a second
    // read hits the memo, never a second policy computation.
    expect(resolution.byCapability.has(MCP_SCOPE_SENTINEL_CAPABILITY)).toBe(
      true,
    );
  });

  it("prefers ANY already-cached per-capability entry (same object the kernel reads)", () => {
    const run = makeAgentRun([{ pattern: "slack:*", effect: "ask" }]);
    const resolution = run.resolution!;
    // Warm the memo the way materializeTools' capability loop does.
    effectiveMcpScopeForRun(run, resolution, scope, new Date(), null);
    const sizeAfterWarm = resolution.byCapability.size;
    const again = effectiveMcpScopeForRun(
      run,
      resolution,
      scope,
      new Date(),
      null,
    );
    expect(again?.ruleSets).toEqual([[{ pattern: "slack:*", effect: "ask" }]]);
    // No additional entries were minted — the cached entry was reused.
    expect(resolution.byCapability.size).toBe(sizeAfterWarm);
  });

  it("returns undefined for a run with no mcp rules anywhere (unrestricted)", () => {
    const run = makeAgentRun([]);
    // An empty rules array IS a ceiling ({rules: []}) — build a truly rule-free
    // run instead by stripping the resourceScope condition.
    const bare: AgentRunIAMContext = {
      ...run,
      resolution: createAgentRunResolution({
        grants: [],
        roles: [],
        roleGrants: [],
        policies: [],
      }),
    };
    const mcpScope = effectiveMcpScopeForRun(
      bare,
      bare.resolution!,
      scope,
      new Date(),
      null,
    );
    expect(mcpScope).toBeUndefined();
  });
});

describe("decideMcpToolEffect — per-call decision", () => {
  it("deny/ask/allow per first-match-wins rules, keyed by lowercase server name", () => {
    const run = makeAgentRun([
      { pattern: "github:read_*", effect: "allow" },
      { pattern: "github:*", effect: "deny" },
      { pattern: "slack:*", effect: "ask" },
    ]);
    const mcpScope = effectiveMcpScopeForRun(
      run,
      run.resolution!,
      scope,
      new Date(),
      null,
    );
    // Display-cased server name "GitHub" is matched via the lowercase key.
    expect(decideMcpToolEffect(mcpScope, "GitHub", "read_repo")).toBe("allow");
    expect(decideMcpToolEffect(mcpScope, "GitHub", "delete_repo")).toBe("deny");
    expect(decideMcpToolEffect(mcpScope, "Slack", "post_message")).toBe("ask");
    expect(decideMcpToolEffect(mcpScope, "linear", "create_issue")).toBe(
      "allow",
    );
    expect(decideMcpToolEffect(undefined, "GitHub", "anything")).toBe("allow");
  });
});

describe("emitMcpRuleAudit — IAM audit rows for deny / ask", () => {
  beforeEach(() => {
    emitAuditMock.mockClear();
    emitAuditMock.mockResolvedValue(undefined);
  });

  it("emits a deny row with the agent principal and server:tool target dimension", () => {
    const run = makeAgentRun([{ pattern: "github:*", effect: "deny" }]);
    emitMcpRuleAudit({
      ctx,
      agentRun: run,
      capability: "mcp.srv_1.delete_repo",
      serverTool: "github:delete_repo",
      effect: "deny",
    });
    expect(emitAuditMock).toHaveBeenCalledTimes(1);
    const args = (emitAuditMock.mock.calls[0] as unknown as [unknown])[0] as {
      capability: string;
      principal: { id: string; kind: string };
      result: { outcome: string; reason?: string };
      target: { kind: string; id: string };
      humanPrincipalId: string | null;
      runLineage: { agentId: string; runId: string };
    };
    expect(args.capability).toBe("mcp.srv_1.delete_repo");
    // principal_kind='agent' derives from the acting principal's kind.
    expect(args.principal).toMatchObject({ id: "prn_agent", kind: "agent" });
    expect(args.result.outcome).toBe("deny");
    expect(args.target).toEqual({ kind: "mcp_tool", id: "github:delete_repo" });
    expect(args.humanPrincipalId).toBe("prn_human");
    expect(args.runLineage).toMatchObject({ agentId: "agt_1", runId: "run_1" });
  });

  it("emits an ask-escalation as pending_approval", () => {
    const run = makeAgentRun([{ pattern: "slack:*", effect: "ask" }]);
    emitMcpRuleAudit({
      ctx,
      agentRun: run,
      capability: "mcp.srv_2.post_message",
      serverTool: "slack:post_message",
      effect: "ask",
    });
    const args = (emitAuditMock.mock.calls[0] as unknown as [unknown])[0] as {
      result: { outcome: string };
    };
    expect(args.result.outcome).toBe("pending_approval");
  });

  it("an audit failure is swallowed (fire-and-forget) — enforcement already happened", async () => {
    emitAuditMock.mockRejectedValueOnce(new Error("clickhouse down"));
    const run = makeAgentRun([{ pattern: "github:*", effect: "deny" }]);
    expect(() =>
      emitMcpRuleAudit({
        ctx,
        agentRun: run,
        capability: "mcp.srv_1.x",
        serverTool: "github:x",
        effect: "deny",
      }),
    ).not.toThrow();
    // Let the rejected promise's .catch handler run.
    await new Promise((r) => setImmediate(r));
  });
});

// ── Glob parity witness (spec §3.7: ONE matcher) ─────────────────────────────
// evaluateMcpRules([{pattern, effect:"deny"}], value) returns "deny" exactly
// when the pattern matches — so it exposes the resolver's matcher for a
// corpus comparison against packages/mcp-config's canonical matchGlob.
describe("glob parity witness — @oxagen/oxagen/iam matcher ≡ @oxagen/mcp-config matchGlob", () => {
  const corpus: Array<[pattern: string, value: string]> = [
    ["*", "github:anything"],
    ["github:*", "github:read_repo"],
    ["github:*", "github:"],
    ["github:*", "slack:read"],
    ["github:read_*", "github:read_repo"],
    ["github:read_*", "github:write_repo"],
    ["*_repo", "github:read_repo"],
    ["git*:delete_*", "github:delete_branch"],
    ["exact:name", "exact:name"],
    ["exact:name", "exact:name2"],
    ["a.b:c", "a.b:c"], // '.' must be escaped, not regex-any
    ["a.b:c", "axb:c"],
    ["s(1):t", "s(1):t"], // regex specials escaped
    ["", "github:x"],
    ["github:*", ""],
  ];

  it("agrees on every corpus entry", () => {
    for (const [pattern, value] of corpus) {
      const viaResolver =
        evaluateMcpRules([{ pattern, effect: "deny" }], value) === "deny";
      expect(
        matchGlob(pattern, value),
        `pattern="${pattern}" value="${value}"`,
      ).toBe(viaResolver);
    }
  });
});
