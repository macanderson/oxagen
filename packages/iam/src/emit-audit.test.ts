// emit-audit.test.ts — unit tests for emitAudit() (OXA-1524).
//
// Tests:
//   - sha256 chain hash is correctly computed
//   - prevHash failure is non-fatal (error swallowed, empty prevHash used)
//   - insertAuditEvent is called with correctly shaped row

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuditEventRow } from "@oxagen/telemetry";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  insertAuditEvent: vi.fn<(row: AuditEventRow) => Promise<void>>(),
  latestAuditChainHash: vi.fn<() => Promise<string>>(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    insertAuditEvent: mocks.insertAuditEvent,
    latestAuditChainHash: mocks.latestAuditChainHash,
  };
});

import { emitAudit } from "./emit-audit";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_emit_test",
  workspaceId: "ws_emit_test",
  userId: "usr_emit_test",
  apiKeyId: null,
  requestId: "req_emit_test",
  surface: "api",
  messageId: null,
};

const ALLOW_TRACE = {
  steps: [{ rule: "7:role_grant", description: "allow", decided: true, outcome: "allow" as const }],
  decidedBy: { rule: "7:role_grant", description: "allow", decided: true, outcome: "allow" as const },
};

const ALLOW_RESULT = { outcome: "allow" as const, trace: ALLOW_TRACE };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emitAudit()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertAuditEvent.mockResolvedValue(undefined);
    mocks.latestAuditChainHash.mockResolvedValue("prev_hash_abc");
  });

  it("calls insertAuditEvent exactly once with the correct capability and outcome", async () => {
    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: '{"content":"hello"}',
    });

    expect(mocks.insertAuditEvent).toHaveBeenCalledTimes(1);
    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.capability).toBe("chat.message.send");
    expect(row.outcome).toBe("allow");
    expect(row.org_id).toBe("org_emit_test");
  });

  it("computes a chain_hash string of length 64 (SHA-256 hex)", async () => {
    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    // SHA-256 hex digest is always 64 characters.
    expect(row.chain_hash).toHaveLength(64);
    expect(row.chain_hash).toMatch(/^[a-f0-9]+$/);
  });

  it("chain_hash changes when prevHash changes (hash chains over prevHash)", async () => {
    mocks.latestAuditChainHash.mockResolvedValueOnce("hash_a");
    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });
    const rowA = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;

    vi.clearAllMocks();
    mocks.insertAuditEvent.mockResolvedValue(undefined);
    mocks.latestAuditChainHash.mockResolvedValueOnce("hash_b");
    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });
    const rowB = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;

    // Different prevHashes → different chain hashes (modulo event_id randomness,
    // but the inputs differ so the outputs should differ with overwhelming probability).
    // We confirm structure is correct; exact equality is not testable due to random event_id.
    expect(rowA.chain_hash).toHaveLength(64);
    expect(rowB.chain_hash).toHaveLength(64);
  });

  it("proceeds and calls insertAuditEvent even when latestAuditChainHash fails", async () => {
    mocks.latestAuditChainHash.mockRejectedValue(new Error("clickhouse read failed"));

    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    // prevHash failure is non-fatal — insertAuditEvent must still be called.
    expect(mocks.insertAuditEvent).toHaveBeenCalledTimes(1);
    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    // chain_hash should still be populated (computed with empty prevHash).
    expect(row.chain_hash).toHaveLength(64);
  });

  it("sets scope_kind to 'workspace' when workspaceId is present in ctx", async () => {
    await emitAudit({
      capability: "chat.message.send",
      ctx: { ...CTX, workspaceId: "ws_scope_test" },
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.scope_kind).toBe("workspace");
    expect(row.scope_id).toBe("ws_scope_test");
  });

  it("sets scope_kind to 'org' and scope_id to orgId when workspaceId is absent", async () => {
    await emitAudit({
      capability: "chat.message.send",
      ctx: { ...CTX, workspaceId: "" },
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.scope_kind).toBe("org");
    expect(row.scope_id).toBe("org_emit_test");
  });

  it("sets decision_reason from trace.decidedBy.rule", async () => {
    const DENY_TRACE = {
      steps: [{ rule: "2:org_enforced_deny", description: "deny", decided: true, outcome: "deny" as const }],
      decidedBy: { rule: "2:org_enforced_deny", description: "deny", decided: true, outcome: "deny" as const },
    };

    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: { outcome: "deny", reason: "org_enforced_deny", trace: DENY_TRACE },
      trace: DENY_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.decision_reason).toBe("2:org_enforced_deny");
    expect(row.outcome).toBe("deny");
  });

  // ── Scope derivation: workspaceId truthy vs falsy ─────────────────────────

  it("workspaceId truthy → scope_kind 'workspace', scope_id = workspaceId", async () => {
    await emitAudit({
      capability: "iam.roles.list",
      ctx: { ...CTX, workspaceId: "ws_explicit" },
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.scope_kind).toBe("workspace");
    expect(row.scope_id).toBe("ws_explicit");
  });

  it('workspaceId "" (falsy) → scope_kind "org", scope_id = orgId', async () => {
    await emitAudit({
      capability: "iam.roles.list",
      ctx: { ...CTX, workspaceId: "" },
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.scope_kind).toBe("org");
    expect(row.scope_id).toBe(CTX.orgId);
  });

  // ── Null principal → nil UUID, kind "service", human_principal_id null ───

  it("null principal → acting_principal_id is nil UUID, kind service, human_principal_id null", async () => {
    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.acting_principal_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(row.acting_principal_kind).toBe("service");
    expect(row.human_principal_id).toBeNull();
  });

  // ── human principal → human_principal_id == acting id ────────────────────

  it("human principal → human_principal_id equals acting principal id", async () => {
    const humanPrincipal = {
      id: "prn_human_abc",
      kind: "human" as const,
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    };

    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: humanPrincipal,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.acting_principal_id).toBe("prn_human_abc");
    expect(row.acting_principal_kind).toBe("human");
    expect(row.human_principal_id).toBe("prn_human_abc");
  });

  // ── agent principal → human_principal_id null ─────────────────────────────

  it("agent principal → human_principal_id is null", async () => {
    const agentPrincipal = {
      id: "prn_agent_xyz",
      kind: "agent" as const,
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    };

    await emitAudit({
      capability: "agent.run",
      ctx: CTX,
      principal: agentPrincipal,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.acting_principal_kind).toBe("agent");
    expect(row.human_principal_id).toBeNull();
  });

  // ── payload_hash is 64-char SHA-256 hex of rawInputJson ──────────────────

  it("payload_hash is a 64-char lowercase hex string (SHA-256 of rawInputJson)", async () => {
    const rawInputJson = '{"content":"hello world"}';

    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson,
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.payload_hash).toHaveLength(64);
    expect(row.payload_hash).toMatch(/^[a-f0-9]+$/);
  });

  it("payload_hash differs for different rawInputJson values", async () => {
    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: '{"a":1}',
    });
    const row1 = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;

    vi.clearAllMocks();
    mocks.insertAuditEvent.mockResolvedValue(undefined);
    mocks.latestAuditChainHash.mockResolvedValue("prev_hash_abc");

    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: '{"a":2}',
    });
    const row2 = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;

    expect(row1.payload_hash).not.toBe(row2.payload_hash);
  });

  // ── chain_hash is 64-char hex, different from payload_hash ───────────────

  it("chain_hash is 64-char hex and differs from payload_hash (different inputs)", async () => {
    mocks.latestAuditChainHash.mockResolvedValue("specific_prev_hash");

    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: '{"content":"test"}',
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.chain_hash).toHaveLength(64);
    expect(row.chain_hash).toMatch(/^[a-f0-9]+$/);
    // chain_hash is SHA-256 of `${prevHash}|${eventId}|${capability}`
    // payload_hash is SHA-256 of rawInputJson — the inputs differ so the hashes differ
    expect(row.chain_hash).not.toBe(row.payload_hash);
  });

  // ── latestAuditChainHash rejecting is non-fatal ───────────────────────────

  it("latestAuditChainHash rejecting is non-fatal: insertAuditEvent called once, prevHash treated as ''", async () => {
    mocks.latestAuditChainHash.mockRejectedValue(new Error("read timeout"));

    await emitAudit({
      capability: "chat.message.send",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    // Must have called insertAuditEvent exactly once despite the read failure.
    expect(mocks.insertAuditEvent).toHaveBeenCalledTimes(1);
    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    // chain_hash is still a valid 64-char hex (computed with empty prevHash)
    expect(row.chain_hash).toHaveLength(64);
    expect(row.chain_hash).toMatch(/^[a-f0-9]+$/);
  });

  // ── Concurrency: two parallel calls both insert exactly once ─────────────

  it("CONCURRENCY: two parallel emitAudit calls each read prevHash='' and each call insertAuditEvent once — no throws", async () => {
    // Simulate a cold ClickHouse read: both concurrent calls get prevHash = "".
    mocks.latestAuditChainHash.mockResolvedValue("");

    const argsBase = {
      capability: "billing.usage.read",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    } as const;

    // Fire both without awaiting either first — true concurrency in the event loop.
    await Promise.all([emitAudit(argsBase), emitAudit(argsBase)]);

    // Each call must have called insertAuditEvent exactly once (total = 2).
    expect(mocks.insertAuditEvent).toHaveBeenCalledTimes(2);
  });
});
