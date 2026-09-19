// check-iam.test.ts — unit tests for checkIAM().
//
// Tests the integration of fetchAuthz → resolve → emitAudit, covering:
//   - Plan-tier ACL gate (non-enterprise bypass)
//   - EMPTY_AUTHZ → defaultEffect "deny" path
//   - Deny path via resolver
//   - pending_approval path via resolver
//   - emitAudit failure non-fatal

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ResolvedPrincipal } from "@oxagen/oxagen";
import type { AuthzData } from "./fetch-authz";
import type { KeyScope } from "./machine-key-scope";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  fetchAuthz: vi.fn<() => Promise<AuthzData>>(),
  resolve: vi.fn(),
  emitAudit: vi.fn<() => Promise<void>>(),
  resolveOrgTier: vi.fn(),
  resolveOrgTierDetailed: vi.fn(),
  canAccessACL: vi.fn(),
  captureError: vi.fn(),
  // Only the non-enterprise bypass branch reaches this: it identifies a
  // purpose-scoped key without a second DB round trip through fetchAuthz,
  // which the bypass branch never calls. Defaults to "no purpose", matching
  // the pre-existing tests' apiKeyId: null fixture, where this is never even
  // invoked.
  readKeyScope: vi.fn<(orgId: string, apiKeyId: string) => Promise<KeyScope>>(
    async () => ({ kind: "missing" }),
  ),
}));

vi.mock("./fetch-authz", () => ({ fetchAuthz: mocks.fetchAuthz }));
vi.mock("./emit-audit", () => ({ emitAudit: mocks.emitAudit }));
vi.mock("@oxagen/oxagen/iam", () => ({ resolve: mocks.resolve }));
vi.mock("./machine-key-scope", () => ({ readKeyScope: mocks.readKeyScope }));
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    resolveOrgTier: mocks.resolveOrgTier,
    resolveOrgTierDetailed: mocks.resolveOrgTierDetailed,
    canAccessACL: mocks.canAccessACL,
  };
});
// checkIAM escalates an emitAudit failure via captureError (in addition to
// logger.error) so a dropped/refused audit write is observable in
// ClickHouse error_events, not just a log line.
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, captureError: mocks.captureError };
});

// Import AFTER mocks are wired.
import { checkIAM } from "./check-iam";

/**
 * checkIAM resolves the tier through `resolveOrgTierDetailed`, not
 * `resolveOrgTier`, because it needs to know whether the answer was
 * ESTABLISHED or merely defaulted to — `free` is both a real tier and the hard
 * default, and only the first is a reason to bypass the resolver (#1384).
 * These tests therefore stub the detailed form; this helper is the
 * "a real subscription said so" case every pre-existing test means.
 */
function mockEstablishedTier(tier: string): void {
  mocks.resolveOrgTierDetailed.mockResolvedValue({
    tier,
    established: true,
    source: "subscription",
  });
}
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: "usr_test",
  apiKeyId: null,
  requestId: "req_test",
  surface: "api",
  messageId: null,
};

const PRINCIPAL: ResolvedPrincipal = {
  id: "prn_test",
  kind: "human",
  orgId: "org_test",
  workspaceId: "ws_test",
};

const EMPTY_AUTHZ: AuthzData = {
  principal: null,
  grants: [],
  roles: [],
  roleGrants: [],
  policies: [],
  apiKeyPurpose: null,
};

const ALLOW_TRACE = {
  steps: [
    {
      rule: "7:role_grant",
      description: "allow via role",
      decided: true,
      outcome: "allow" as const,
    },
  ],
  decidedBy: {
    rule: "7:role_grant",
    description: "allow via role",
    decided: true,
    outcome: "allow" as const,
  },
};

const DENY_TRACE = {
  steps: [
    {
      rule: "8:default",
      description: "default deny",
      decided: true,
      outcome: "deny" as const,
    },
  ],
  decidedBy: {
    rule: "8:default",
    description: "default deny",
    decided: true,
    outcome: "deny" as const,
  },
};

const PENDING_TRACE = {
  steps: [
    {
      rule: "5:workspace_require_approval",
      description: "pending",
      decided: true,
      outcome: "pending_approval" as const,
    },
  ],
  decidedBy: {
    rule: "5:workspace_require_approval",
    description: "pending",
    decided: true,
    outcome: "pending_approval" as const,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkIAM()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitAudit.mockResolvedValue(undefined);
    // Default: enterprise org — resolver runs. Tests that want non-enterprise
    // override canAccessACL.mockReturnValue(false) explicitly.
    mockEstablishedTier("enterprise");
    mocks.canAccessACL.mockReturnValue(true);
  });

  // ── Plan-tier ACL gate ───────────────────────────────────────────────────

  it("returns allow and skips the resolver for non-enterprise orgs on iam.* capabilities", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("build");

    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
  });

  it("OXA-2058: non-enterprise bypass path also escalates via captureError when emitAudit rejects", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("build");
    const auditErr = new Error("clickhouse down (bypass path)");
    mocks.emitAudit.mockRejectedValue(auditErr);

    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");

    // Let the fire-and-forget emitAudit(...).catch(...) handler run.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.captureError).toHaveBeenCalledTimes(1);
    const call = mocks.captureError.mock.calls[0]?.[0] as {
      error: unknown;
      capability: string;
    };
    expect(call.error).toBe(auditErr);
    expect(call.capability).toBe("iam.roles.list");
  });

  it("uses ctx.planTier when present (no resolveOrgTier call)", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    const ctxWithTier: CapabilityContext = {
      ...CTX,
      planTier: "scale" as const,
    };

    const result = await checkIAM({
      capability: "iam.grants.read",
      ctx: ctxWithTier,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolveOrgTierDetailed).not.toHaveBeenCalled();
    expect(mocks.canAccessACL).toHaveBeenCalledWith("scale");
  });

  it("falls through to the resolver for enterprise orgs on iam.* capabilities", async () => {
    mocks.canAccessACL.mockReturnValue(true); // enterprise
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL,
    });
    mocks.resolve.mockReturnValue({ outcome: "allow", trace: ALLOW_TRACE });

    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(result.result.outcome).toBe("allow");
  });

  // ── EMPTY_AUTHZ → defaultEffect deny ────────────────────────────────────

  it("passes EMPTY_AUTHZ through the resolver when fetchAuthz returns no principal", async () => {
    mocks.fetchAuthz.mockResolvedValue(EMPTY_AUTHZ);
    mocks.resolve.mockReturnValue({
      outcome: "deny",
      reason: "no_grant",
      trace: DENY_TRACE,
    });

    const result = await checkIAM({
      capability: "send_message",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("deny");
    expect(result.principal).toBeNull();
    // Resolver is always called (even for null principal — uses sentinel principal).
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  // ── Deny path ────────────────────────────────────────────────────────────

  it("returns deny result from the resolver", async () => {
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL,
    });
    mocks.resolve.mockReturnValue({
      outcome: "deny",
      reason: "no_grant",
      trace: DENY_TRACE,
    });

    const result = await checkIAM({
      capability: "send_message",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("deny");
    expect("reason" in result.result && result.result.reason).toBe("no_grant");
    expect(result.principal).toEqual(PRINCIPAL);
  });

  // ── pending_approval path ────────────────────────────────────────────────

  it("returns pending_approval result from the resolver", async () => {
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL,
    });
    mocks.resolve.mockReturnValue({
      outcome: "pending_approval",
      trace: PENDING_TRACE,
    });

    const result = await checkIAM({
      capability: "send_message",
      ctx: CTX,
      defaultEffect: "require_approval",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("pending_approval");
  });

  // ── emitAudit fire-and-forget ────────────────────────────────────────────

  it("calls emitAudit after the resolve step", async () => {
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL,
    });
    mocks.resolve.mockReturnValue({ outcome: "allow", trace: ALLOW_TRACE });

    await checkIAM({
      capability: "send_message",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
  });

  it("does NOT throw when emitAudit rejects — audit failure is non-fatal, but escalates via captureError (OXA-2058)", async () => {
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL,
    });
    mocks.resolve.mockReturnValue({ outcome: "allow", trace: ALLOW_TRACE });
    const auditErr = new Error("clickhouse down");
    mocks.emitAudit.mockRejectedValue(auditErr);

    // Must not throw despite emitAudit failing.
    const result = await checkIAM({
      capability: "send_message",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");

    // Let the fire-and-forget emitAudit(...).catch(...) handler run.
    await Promise.resolve();
    await Promise.resolve();

    // An audit-emission failure must be observable beyond a log
    // line — escalated to captureError (ClickHouse error_events + optional
    // alert webhook) so it can never silently vanish.
    expect(mocks.captureError).toHaveBeenCalledTimes(1);
    const call = mocks.captureError.mock.calls[0]?.[0] as {
      error: unknown;
      capability: string;
    };
    expect(call.error).toBe(auditErr);
    expect(call.capability).toBe("send_message");
  });

  // ── isAclCapability boundary cases ──────────────────────────────────────

  it("billing.acl.manage (enterprise ACL prefix) on non-enterprise → allow, resolver skipped", async () => {
    // "billing.acl." prefix matches isAclCapability → non-enterprise bypass
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("scale");

    const result = await checkIAM({
      capability: "billing.acl.manage",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
  });

  it('exact "iam" capability on non-enterprise → allow, resolver skipped', async () => {
    // capability === "iam" matches the third branch of isAclCapability
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("build");

    const result = await checkIAM({
      capability: "iam",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
  });

  it("any capability on non-enterprise → allow, resolver skipped", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("scale");

    const result = await checkIAM({
      capability: "send_message",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
  });

  it("non-enterprise fast-path covers iam.* capabilities too", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("build");

    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
  });
});

/**
 * #1384: the tier gate turned a billing state into a security state.
 *
 * `checkIAM` bypasses the resolver entirely below `enterprise`, so anything
 * that under-reports a tier switches IAM off — and tier resolution counted a
 * subscription only when its status was exactly `active`, while every other
 * billing query in the package counts `trialing` too. An enterprise org in
 * trial therefore had every capability check return allow with zero policy
 * consulted.
 */
describe("checkIAM tier gate fails closed (#1384)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitAudit.mockResolvedValue(undefined);
    mocks.canAccessACL.mockImplementation(
      (tier: string) => tier === "enterprise",
    );
    mocks.fetchAuthz.mockResolvedValue(EMPTY_AUTHZ);
    mocks.resolve.mockReturnValue({
      outcome: "deny" as const,
      trace: DENY_TRACE,
      principal: PRINCIPAL,
    });
  });

  it("enforces an enterprise org whose subscription is trialing", async () => {
    // The tier resolver now counts a trial, so this org resolves enterprise.
    mockEstablishedTier("enterprise");

    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.resolve).toHaveBeenCalled();
    expect(result.result.outcome).not.toBe("allow");
  });

  it("enforces rather than bypasses when nothing established the tier", async () => {
    // No subscription and no organizations row: `free` here is the hard
    // default, not a fact about the org, and treating the default as a licence
    // to bypass allowed every capability with no policy consulted.
    mocks.resolveOrgTierDetailed.mockResolvedValue({
      tier: "free",
      established: false,
      source: "absent-org",
    });

    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.resolve).toHaveBeenCalled();
    expect(result.result.outcome).not.toBe("allow");
  });

  it("still bypasses a genuinely free org, so nothing gets slower or stricter", async () => {
    mocks.resolveOrgTierDetailed.mockResolvedValue({
      tier: "free",
      established: true,
      source: "organization",
    });

    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("takes a caller-supplied planTier as established", async () => {
    const result = await checkIAM({
      capability: "iam.roles.list",
      ctx: { ...CTX, planTier: "build" as const },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.resolveOrgTierDetailed).not.toHaveBeenCalled();
  });
});

// ── Evidence attribution for a purpose-scoped key (#3151) ─────────────────
//
// fetchAuthz still resolves a purpose-scoped key (tacho_host_v1,
// tacho_gateway_v1, ...) to its creator's role grants. That inheritance is
// unchanged and untested again here (fetch-authz.test.ts owns it). What
// these tests pin is the SEPARATE question: what identity does the AUDIT row
// name, and does the kernel's own resolvedPrincipal stay the one resolve()
// actually matched grants against.
describe("checkIAM(): purpose-scoped key evidence attribution", () => {
  const GATEWAY_CTX: CapabilityContext = {
    ...CTX,
    userId: null,
    apiKeyId: "aky_gateway",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitAudit.mockResolvedValue(undefined);
    mockEstablishedTier("enterprise");
    mocks.canAccessACL.mockReturnValue(true);
  });

  it("audits a tacho_gateway_v1 call against the credential, not the creator whose grants allowed it", async () => {
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL, // the enroller's principal, used for role matching
      apiKeyPurpose: "tacho_gateway_v1",
    });
    mocks.resolve.mockReturnValue({ outcome: "allow", trace: ALLOW_TRACE });

    const result = await checkIAM({
      capability: "query_ontology",
      ctx: GATEWAY_CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    // resolve() matched grants against the REAL (enroller) principal.
    // Unchanged, and required for enterprise-tier machine flows to work.
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ principal: PRINCIPAL }),
    );

    // The audit row names the credential, never the enroller's principal.
    expect(mocks.emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: {
          id: "aky_gateway",
          kind: "service",
          orgId: "org_test",
          workspaceId: "ws_test",
        },
      }),
    );

    // What the kernel threads onward as resolvedPrincipal (feeds tenant-scope
    // RLS) is the ORIGINAL principal, not the audit substitute. An API key
    // id is not a row in iam.principals, and widening the swap there would
    // trade a real vulnerability for a dangling foreign reference.
    expect(result.principal).toEqual(PRINCIPAL);
  });

  it("leaves a plain org key's audit and returned principal alone", async () => {
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL,
      apiKeyPurpose: null,
    });
    mocks.resolve.mockReturnValue({ outcome: "allow", trace: ALLOW_TRACE });

    const result = await checkIAM({
      capability: "generate_markdown",
      ctx: GATEWAY_CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ principal: PRINCIPAL }),
    );
    expect(result.principal).toEqual(PRINCIPAL);
  });

  it("leaves a cli_session_v1 key's audit alone: it is a person's own credential", async () => {
    mocks.fetchAuthz.mockResolvedValue({
      ...EMPTY_AUTHZ,
      principal: PRINCIPAL,
      apiKeyPurpose: "cli_session_v1",
    });
    mocks.resolve.mockReturnValue({ outcome: "allow", trace: ALLOW_TRACE });

    await checkIAM({
      capability: "generate_markdown",
      ctx: GATEWAY_CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ principal: PRINCIPAL }),
    );
  });

  // ── The non-enterprise fast path: the tier where this was invisible ───────
  //
  // This branch is the one nothing checked before #3151: it audited every
  // API-key call as `principal: null` (an anonymous zero-id service
  // principal), which was already NOT the enroller's identity, but also
  // named no credential at all. It now identifies the key when it can, on
  // exactly the tier `checkIAM`'s own module comment calls "the 90% of
  // customers who don't need ACL management": the common case, not an edge
  // one.

  it("non-enterprise tier: attributes a gateway key's audit to the credential without running the resolver", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("build");
    mocks.readKeyScope.mockResolvedValue({
      kind: "purpose",
      purpose: "tacho_gateway_v1",
      hostEnrollmentId: "tch_1",
    });

    const result = await checkIAM({
      capability: "query_ontology",
      ctx: GATEWAY_CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    // The resolver never runs on this tier. machineKeyDenial (run by the
    // bootstrap.ts adapter BEFORE checkIAM, not exercised in this unit test)
    // is what stands between a gateway key and a capability outside its
    // mandate; this fast path only decides evidence once already allowed.
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
    expect(mocks.readKeyScope).toHaveBeenCalledWith("org_test", "aky_gateway");
    expect(mocks.emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: {
          id: "aky_gateway",
          kind: "service",
          orgId: "org_test",
          workspaceId: "ws_test",
        },
      }),
    );
    // This tier already returns null for resolvedPrincipal (no resolver ran
    // to produce a real one), so there is nothing here for
    // machineAttributedPrincipal's RLS guard to protect. The kernel gets
    // exactly what it got before this change.
    expect(result.principal).toBeNull();
  });

  it("non-enterprise tier: a plain org key (or none) still audits as the anonymous service principal", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("build");
    mocks.readKeyScope.mockResolvedValue({ kind: "personal" });

    const result = await checkIAM({
      capability: "generate_markdown",
      ctx: GATEWAY_CTX,
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(result.result.outcome).toBe("allow");
    expect(mocks.emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ principal: null }),
    );
    expect(result.principal).toBeNull();
  });

  it("non-enterprise tier: no apiKeyId (a human session) never calls readKeyScope", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mockEstablishedTier("build");

    await checkIAM({
      capability: "generate_markdown",
      ctx: CTX, // apiKeyId: null
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.readKeyScope).not.toHaveBeenCalled();
  });
});
