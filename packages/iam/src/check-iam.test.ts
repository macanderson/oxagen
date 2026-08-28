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

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  fetchAuthz: vi.fn<() => Promise<AuthzData>>(),
  resolve: vi.fn(),
  emitAudit: vi.fn<() => Promise<void>>(),
  resolveOrgTier: vi.fn(),
  canAccessACL: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("./fetch-authz", () => ({ fetchAuthz: mocks.fetchAuthz }));
vi.mock("./emit-audit", () => ({ emitAudit: mocks.emitAudit }));
vi.mock("@oxagen/oxagen/iam", () => ({ resolve: mocks.resolve }));
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    resolveOrgTier: mocks.resolveOrgTier,
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
    mocks.resolveOrgTier.mockResolvedValue("enterprise");
    mocks.canAccessACL.mockReturnValue(true);
  });

  // ── Plan-tier ACL gate ───────────────────────────────────────────────────

  it("returns allow and skips the resolver for non-enterprise orgs on iam.* capabilities", async () => {
    mocks.canAccessACL.mockReturnValue(false);
    mocks.resolveOrgTier.mockResolvedValue("build");

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
    mocks.resolveOrgTier.mockResolvedValue("build");
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
    expect(mocks.resolveOrgTier).not.toHaveBeenCalled();
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
    mocks.resolveOrgTier.mockResolvedValue("scale");

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
    mocks.resolveOrgTier.mockResolvedValue("build");

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
    mocks.resolveOrgTier.mockResolvedValue("scale");

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
    mocks.resolveOrgTier.mockResolvedValue("build");

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
