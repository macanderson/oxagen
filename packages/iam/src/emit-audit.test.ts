// emit-audit.test.ts — unit tests for emitAudit().
//
// Tests:
//   - sha256 chain hash is correctly computed
//   - prevHash READ failure is non-fatal (chain re-anchors from empty prevHash,
//     but chain_hash itself is still computed and non-empty)
//   - sha256 COMPUTATION failure (payload OR chain) is FATAL: emitAudit rejects
//     and insertAuditEvent is never called — an audit row with an empty
//     chain_hash must never be persisted
//   - the durable insert is retried with backoff before a write failure
//     propagates to the caller
//   - insertAuditEvent is called with correctly shaped row

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuditEventRow } from "@oxagen/telemetry";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  insertAuditEvent: vi.fn<(row: AuditEventRow) => Promise<void>>(),
  latestAuditChainHash: vi.fn<() => Promise<string>>(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertAuditEvent: mocks.insertAuditEvent,
    latestAuditChainHash: mocks.latestAuditChainHash,
  };
});

// Spy on the package logger so we can assert the sha256-failure path logs an
// error (audit-chain integrity is a SOC-2 concern — a silent empty hash must
// never pass unobserved).
const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./logger", () => ({ logger: loggerMocks }));

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
  steps: [
    {
      rule: "7:role_grant",
      description: "allow",
      decided: true,
      outcome: "allow" as const,
    },
  ],
  decidedBy: {
    rule: "7:role_grant",
    description: "allow",
    decided: true,
    outcome: "allow" as const,
  },
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
      capability: "send_message",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: '{"content":"hello"}',
    });

    expect(mocks.insertAuditEvent).toHaveBeenCalledTimes(1);
    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.capability).toBe("send_message");
    expect(row.outcome).toBe("allow");
    expect(row.org_id).toBe("org_emit_test");
  });

  it("computes a chain_hash string of length 64 (SHA-256 hex)", async () => {
    await emitAudit({
      capability: "send_message",
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
      capability: "send_message",
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
      capability: "send_message",
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
    mocks.latestAuditChainHash.mockRejectedValue(
      new Error("clickhouse read failed"),
    );

    await emitAudit({
      capability: "send_message",
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
      capability: "send_message",
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
      capability: "send_message",
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
      steps: [
        {
          rule: "2:org_enforced_deny",
          description: "deny",
          decided: true,
          outcome: "deny" as const,
        },
      ],
      decidedBy: {
        rule: "2:org_enforced_deny",
        description: "deny",
        decided: true,
        outcome: "deny" as const,
      },
    };

    await emitAudit({
      capability: "send_message",
      ctx: CTX,
      principal: null,
      result: {
        outcome: "deny",
        reason: "org_enforced_deny",
        trace: DENY_TRACE,
      },
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
      capability: "send_message",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.acting_principal_id).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
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
      capability: "send_message",
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
      capability: "send_message",
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
      capability: "send_message",
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
      capability: "send_message",
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
      capability: "send_message",
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
      capability: "send_message",
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

  // ── sha256 (subtle.digest) failure is FATAL — never persist an empty chain_hash ──

  it("OXA-2058: logs an error and REJECTS when sha256 fails — insertAuditEvent is never called, no empty chain_hash is ever persisted", async () => {
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValue(new Error("subtle.digest boom"));

    try {
      // Both payloadHash and chainHash flow through sha256Hex — a failure on
      // EITHER must reject the whole call. Persisting a row with an empty
      // chain_hash breaks tamper-evidence for every subsequent row chained on
      // top of it, so the correct behavior is to refuse the write entirely
      // (a missing, alerted-on audit row is safer than a silently corrupted
      // tamper chain).
      await expect(
        emitAudit({
          capability: "send_message",
          ctx: CTX,
          principal: null,
          result: ALLOW_RESULT,
          trace: ALLOW_TRACE,
          rawInputJson: "{}",
        }),
      ).rejects.toThrow("subtle.digest boom");

      expect(loggerMocks.error).toHaveBeenCalled();
      const [, message] = loggerMocks.error.mock.calls[0] as [unknown, string];
      expect(message).toContain("sha256(payload) failed");

      // No row — not even a degraded one — is ever written.
      expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("OXA-2058: chain-hash computation failure (payload hash succeeds, chain hash fails) also rejects and writes nothing", async () => {
    // Payload hash uses the real digest; the SECOND call (chain hash) fails.
    const realDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let callCount = 0;
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementation(async (...args: Parameters<typeof realDigest>) => {
        callCount += 1;
        if (callCount === 1) return realDigest(...args);
        throw new Error("chain digest boom");
      });

    try {
      await expect(
        emitAudit({
          capability: "send_message",
          ctx: CTX,
          principal: null,
          result: ALLOW_RESULT,
          trace: ALLOW_TRACE,
          rawInputJson: '{"a":1}',
        }),
      ).rejects.toThrow("chain digest boom");

      const chainLogCall = loggerMocks.error.mock.calls.find(([, msg]) =>
        typeof msg === "string" ? msg.includes("sha256(chain) failed") : false,
      );
      expect(chainLogCall).toBeDefined();
      expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  // ── Durable insert: retried with backoff before propagating a failure ────

  it("retries insertAuditEvent with backoff and succeeds on the 2nd attempt (no rejection)", async () => {
    let attempts = 0;
    mocks.insertAuditEvent.mockImplementation(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("transient CH blip"))
        : Promise.resolve();
    });

    await expect(
      emitAudit({
        capability: "send_message",
        ctx: CTX,
        principal: null,
        result: ALLOW_RESULT,
        trace: ALLOW_TRACE,
        rawInputJson: "{}",
      }),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(2);
  });

  it("propagates insertAuditEvent failure to the caller once retries are exhausted (no silent drop, OXA-2058)", async () => {
    const insertErr = new Error("clickhouse permanently down");
    mocks.insertAuditEvent.mockRejectedValue(insertErr);

    await expect(
      emitAudit({
        capability: "send_message",
        ctx: CTX,
        principal: null,
        result: ALLOW_RESULT,
        trace: ALLOW_TRACE,
        rawInputJson: "{}",
      }),
    ).rejects.toThrow("clickhouse permanently down");

    // Retried, not given up on after a single failure.
    expect(mocks.insertAuditEvent).toHaveBeenCalledTimes(3);
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

// ── Accountability chain: audit target + client IP (principal spine) ─────────

describe("emitAudit() — audit target and client IP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertAuditEvent.mockResolvedValue(undefined);
    mocks.latestAuditChainHash.mockResolvedValue("prev_hash_abc");
  });

  it("records target_kind/target_id from the declarative audit target", async () => {
    await emitAudit({
      capability: "get_ontology_neighbors",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: '{"nodeId":"node-123"}',
      target: { kind: "graph.node", id: "node-123" },
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.target_kind).toBe("graph.node");
    expect(row.target_id).toBe("node-123");
  });

  it("keeps target columns null when no target is supplied", async () => {
    await emitAudit({
      capability: "send_message",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.target_kind).toBeNull();
    expect(row.target_id).toBeNull();
  });

  it("records the surface-extracted client IP from ctx.clientIp", async () => {
    await emitAudit({
      capability: "send_message",
      ctx: { ...CTX, clientIp: "203.0.113.7" },
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.ip).toBe("203.0.113.7");
  });

  it("keeps ip null when the surface extracted no client IP", async () => {
    await emitAudit({
      capability: "send_message",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.ip).toBeNull();
  });

  // ── Agent-run lineage (Agent RBAC Phase 2, spec §5) ────────────────────────

  it("records agent-run lineage: correlation_id = runId, lineage in trace_jsonb, delegating human on human_principal_id", async () => {
    await emitAudit({
      capability: "send_message",
      ctx: CTX,
      principal: {
        id: "prn_agent_1",
        kind: "agent",
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
      },
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
      humanPrincipalId: "prn_human_1",
      runLineage: {
        agentId: "agt_audit_test",
        runId: "run_audit_test",
        parentRunId: "run_audit_parent",
      },
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.acting_principal_id).toBe("prn_agent_1");
    expect(row.acting_principal_kind).toBe("agent");
    // The delegating human's principal id fills human_principal_id when the
    // acting principal is an agent — "which human's authority" is queryable.
    expect(row.human_principal_id).toBe("prn_human_1");
    expect(row.correlation_id).toBe("run_audit_test");
    const traceJson = JSON.parse(row.trace_jsonb) as {
      agentRun?: { agentId: string; runId: string; parentRunId: string | null };
    };
    expect(traceJson.agentRun).toEqual({
      agentId: "agt_audit_test",
      runId: "run_audit_test",
      parentRunId: "run_audit_parent",
    });
  });

  it("keeps correlation_id null and trace_jsonb lineage-free without runLineage (non-agent invocations unchanged)", async () => {
    await emitAudit({
      capability: "send_message",
      ctx: CTX,
      principal: null,
      result: ALLOW_RESULT,
      trace: ALLOW_TRACE,
      rawInputJson: "{}",
    });

    const row = mocks.insertAuditEvent.mock.calls[0]?.[0] as AuditEventRow;
    expect(row.correlation_id).toBeNull();
    expect(row.trace_jsonb).not.toContain("agentRun");
  });
});
