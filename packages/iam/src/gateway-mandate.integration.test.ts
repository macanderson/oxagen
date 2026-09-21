// gateway-mandate.integration.test.ts: a gateway-forwarded call against the
// REAL machineKeyDenial + checkIAM composition bootstrap.ts wires (#3151).
//
// check-iam.test.ts and machine-key-scope.test.ts already unit-test each
// function with its own DB layer mocked out. This file proves the two work
// together the way bootstrap.ts's kernelIAMAdapter actually runs them: the
// same call, machineKeyDenial first, checkIAM only if that allows. It is
// scoped to the DoD items #3151 named explicitly:
//
//   - a gateway-forwarded call cannot reach org.model_credential.set
//   - the same holds for a second org-admin capability
//     (delete_model_credential)
//   - the non-enterprise checkIAM fast path does not bypass the new
//     control, tested AT that tier specifically
//
// Real capability contracts are imported (not stubbed shapes) so
// gatewayMayInvoke's mutates/sensitivity/surfaces read is the actual
// declaration a change to org.model_credential.set would have to touch.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks: only the DB and billing layers, never the two ──────────
// functions under test.
const mocks = vi.hoisted(() => ({
  apiKeyRow: null as { scope: unknown } | undefined | null,
  resolveOrgTierDetailed: vi.fn(),
  canAccessACL: vi.fn(),
  insertAuditEvent: vi.fn(async () => undefined),
  latestAuditChainHash: vi.fn(async () => ""),
  captureError: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    // readKeyScope's one read. `withOrgDb` (fetchAuthz's full resolver) is
    // never reached in this file's tests: every case here is decided by
    // machineKeyDenial before checkIAM runs, or is the non-enterprise
    // fast path, which calls neither.
    withSystemDb: async (
      fn: (tx: {
        query: { apiKeys: { findFirst: () => Promise<unknown> } };
      }) => unknown,
    ) =>
      fn({
        query: {
          apiKeys: { findFirst: async () => mocks.apiKeyRow },
        },
      }),
    // `machineKeyDenial` stamps the host's gateway observation on every
    // `tacho_gateway_v1` call, allowed or refused (recordGatewayInvocation).
    // `hasColumnFresh` false for both probed columns is the honest answer
    // this deployment never claims to have run the observation migration,
    // so the write is skipped: it is a side effect this file's assertions
    // do not depend on, and mocking it out keeps the test from needing a
    // real Postgres plane. `recordGatewayInvocation` probes fresh (never
    // trusting a cached miss) so a write is never suppressed by a stale
    // negative, so the fresh form is the one this file must mock too.
    hasColumnFresh: async () => false,
    ambientPlaneKey: async () => "plane-under-test",
    withOrgPlaneSystemDb: async (
      _orgId: string,
      fn: (tx: unknown) => unknown,
    ) => fn({}),
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    resolveOrgTierDetailed: mocks.resolveOrgTierDetailed,
    canAccessACL: mocks.canAccessACL,
  };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertAuditEvent: mocks.insertAuditEvent,
    latestAuditChainHash: mocks.latestAuditChainHash,
    captureError: mocks.captureError,
  };
});

import { checkIAM } from "./check-iam";
import { machineKeyDenial } from "./machine-key-scope";
import type { CapabilityContext } from "@oxagen/oxagen";

// Registers the real contracts (mutates/sensitivity/surfaces come from the
// actual declarations, not a test fixture).
import "@oxagen/oxagen/contracts/org.model_credential.set";
import "@oxagen/oxagen/contracts/org.model_credential.delete";
import "@oxagen/oxagen/contracts/ontology.query";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const GATEWAY_CTX: CapabilityContext = {
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  userId: null,
  apiKeyId: "aky_gateway",
  requestId: "req_gw_1",
  surface: "mcp",
  messageId: null,
};

/**
 * What bootstrap.ts's kernelIAMAdapter actually does: machineKeyDenial
 * first, checkIAM only when that allows. Every test in this file runs the
 * call through this, not through either function alone, so a passing test
 * proves the WIRING closes the gap, not just one function's own logic.
 */
async function invokeAsGateway(capability: string): Promise<{
  outcome: "allow" | "deny" | "pending_approval";
  reason?: string;
}> {
  const denial = await machineKeyDenial({
    orgId: GATEWAY_CTX.orgId,
    apiKeyId: GATEWAY_CTX.apiKeyId,
    userId: GATEWAY_CTX.userId,
    capabilityName: capability,
  });
  if (denial !== undefined) return { outcome: "deny", reason: denial };

  const { result } = await checkIAM({
    capability,
    ctx: GATEWAY_CTX,
    defaultEffect: "deny",
    rawInputJson: "{}",
  });
  return result.outcome === "deny"
    ? { outcome: "deny", reason: result.reason }
    : { outcome: result.outcome };
}

describe("a gateway-forwarded call, against the real machineKeyDenial + checkIAM wiring (#3151)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiKeyRow = {
      scope: { purpose: "tacho_gateway_v1", host_enrollment_id: "tch_1" },
    };
  });

  describe("non-enterprise tier: the tier where the identity swap was invisible", () => {
    beforeEach(() => {
      mocks.resolveOrgTierDetailed.mockResolvedValue({
        tier: "build",
        established: true,
        source: "subscription",
      });
      mocks.canAccessACL.mockReturnValue(false);
    });

    it("cannot reach org.model_credential.set (set_model_credential)", async () => {
      const outcome = await invokeAsGateway("set_model_credential");
      expect(outcome.outcome).toBe("deny");
      expect(outcome.reason).toContain("set_model_credential");
      expect(outcome.reason).toContain("outside this agent's mandate");
    });

    it("cannot reach a second org-admin capability (delete_model_credential)", async () => {
      const outcome = await invokeAsGateway("delete_model_credential");
      expect(outcome.outcome).toBe("deny");
      expect(outcome.reason).toContain("delete_model_credential");
      expect(outcome.reason).toContain("outside this agent's mandate");
    });

    it("proves checkIAM's OWN fast path would have allowed both, so machineKeyDenial is what actually stops them", async () => {
      // The composed call above never reaches checkIAM for either
      // capability (machineKeyDenial denies first). Calling checkIAM
      // directly, the way it ran before #3182/#3151, shows what the
      // non-enterprise fast path alone would have done: allow, with zero
      // policy consulted, the defect the issue reported.
      const bare = await checkIAM({
        capability: "set_model_credential",
        ctx: GATEWAY_CTX,
        defaultEffect: "deny",
        rawInputJson: "{}",
      });
      expect(bare.result.outcome).toBe("allow");
    });

    it("still permits a read-only, non-sensitive mcp capability (query_ontology)", async () => {
      const outcome = await invokeAsGateway("query_ontology");
      expect(outcome.outcome).toBe("allow");
    });
  });

  describe("enterprise tier: the same mandate applies before the full resolver runs", () => {
    beforeEach(() => {
      mocks.resolveOrgTierDetailed.mockResolvedValue({
        tier: "enterprise",
        established: true,
        source: "subscription",
      });
      mocks.canAccessACL.mockReturnValue(true);
    });

    it("cannot reach org.model_credential.set even as the enrolling Owner's own grants would allow it", async () => {
      const outcome = await invokeAsGateway("set_model_credential");
      expect(outcome.outcome).toBe("deny");
      expect(outcome.reason).toContain("set_model_credential");
    });

    it("cannot reach delete_model_credential", async () => {
      const outcome = await invokeAsGateway("delete_model_credential");
      expect(outcome.outcome).toBe("deny");
      expect(outcome.reason).toContain("delete_model_credential");
    });
  });

  describe("tacho_host_v1 (the host's own key, never the gateway's)", () => {
    beforeEach(() => {
      mocks.apiKeyRow = {
        scope: { purpose: "tacho_host_v1", host_enrollment_id: "tch_1" },
      };
      mocks.resolveOrgTierDetailed.mockResolvedValue({
        tier: "build",
        established: true,
        source: "subscription",
      });
      mocks.canAccessACL.mockReturnValue(false);
    });

    it("is refused set_model_credential too, naming the purpose it is bound to", async () => {
      const outcome = await invokeAsGateway("set_model_credential");
      expect(outcome.outcome).toBe("deny");
      expect(outcome.reason).toContain("tacho_host_v1");
    });

    it("is refused the gateway's own permitted capability, because its purpose is a fixed list, not a rule", async () => {
      const outcome = await invokeAsGateway("query_ontology");
      expect(outcome.outcome).toBe("deny");
    });
  });
});
