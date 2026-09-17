/**
 * The principal a `cli_session_v1` key acts as on the MCP surface.
 *
 * `resolveApiKey` resolves a CLI session key to the person who approved
 * `oxagen login` (re-checking their org and workspace membership on every
 * call) and every other key to `userId: null`. `apps/api`'s auth middleware
 * puts that person on the request; this surface used to discard it, so one
 * credential authorized as two different principals depending on hostname.
 *
 * That mattered because `assertCallerRole`
 * (`packages/handlers/src/lib/capability-role-guard.ts`) short-circuits on a
 * context with no `userId`, and on a NON-ENTERPRISE org it is the only role
 * gate that runs at all: `checkIAM`'s `tier_gate` allows such an org
 * unconditionally without reading a contract's `defaultRoles`. The first test
 * below pins that tier fact rather than assuming it, then the escalation is
 * reproduced end to end on it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/auth", () => ({ resolveApiKey: vi.fn() }));
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));

// `assertCallerRole` reads org_users / workspace_users through withSystemDb.
const { orgUsersRole } = vi.hoisted(() => ({
  orgUsersRole: { value: "member" as string | null },
}));
vi.mock("@oxagen/database", () => ({
  schema: {
    orgUsers: { orgId: "org_id", userId: "user_id", role: "role" },
    workspaceUsers: {
      workspaceId: "workspace_id",
      userId: "user_id",
      role: "role",
    },
  },
  withSystemDb: (fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              orgUsersRole.value === null ? [] : [{ role: orgUsersRole.value }],
          }),
        }),
      }),
    }),
}));

// checkIAM's tier fast-path schedules a fire-and-forget audit write; the
// telemetry client is mocked so this test never reaches ClickHouse.
vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertAuditEvent: vi.fn(async () => undefined),
  latestAuditChainHash: vi.fn(async () => ""),
  captureError: vi.fn(),
}));

import { resolveApiKey } from "@oxagen/auth";
import { checkIAM } from "@oxagen/iam/check-iam";
import { assertCallerRole } from "@oxagen/handlers/lib/capability-role-guard";
import { resolveMcpContext } from "./context";

/** A tier `canAccessACL` says has no ACLs — the tier this bug lives on. */
const NON_ENTERPRISE_TIER = "build" as const;

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
/** Alice: org Admin when she ran `oxagen login`, demoted to Member since. */
const ALICE = "33333333-3333-4333-8333-333333333333";

/**
 * `set_model_credential`'s own shape: org Owner/Admin only. Stated here rather
 * than imported so the test pins the gate's behaviour on a role table, not the
 * contract registry's current contents.
 */
const OWNER_ADMIN_ONLY = {
  name: "set_model_credential",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
} as const;

function cliSessionKeyFor(userId: string | null): void {
  vi.mocked(resolveApiKey).mockResolvedValue({
    ok: true,
    orgId: ORG,
    workspaceId: WORKSPACE,
    apiKeyId: "44444444-4444-4444-8444-444444444444",
    userId,
  });
}

beforeEach(() => {
  vi.mocked(resolveApiKey).mockReset();
  orgUsersRole.value = "member";
});

describe("a CLI session key on MCP acts for the person who approved it", () => {
  it("allows unconditionally at the non-enterprise tier, so the role gate is the only gate", async () => {
    const result = await checkIAM({
      capability: OWNER_ADMIN_ONLY.name,
      ctx: {
        orgId: ORG,
        workspaceId: WORKSPACE,
        userId: ALICE,
        apiKeyId: "44444444-4444-4444-8444-444444444444",
        requestId: "req-tier",
        surface: "mcp",
        messageId: null,
        planTier: NON_ENTERPRISE_TIER,
      },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });
    expect(result.result.outcome).toBe("allow");
    expect(result.result.trace.decidedBy?.rule).toBe("tier_gate");
  });

  it("puts the key's person on the context", async () => {
    cliSessionKeyFor(ALICE);
    const resolution = await resolveMcpContext(
      "Bearer ox_cli_session",
      "req-1",
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.ctx.userId).toBe(ALICE);
  });

  it("refuses an Owner/Admin capability to a demoted Admin at the non-enterprise tier", async () => {
    // The escalation. Alice was an org Admin when `oxagen login` minted her
    // key; she has since been demoted to Member. She is still in the org, so
    // the revoke-on-removal path never fired and `resolveApiKey`'s recheck
    // (membership, not role) still resolves the key to her.
    cliSessionKeyFor(ALICE);
    orgUsersRole.value = "member";

    const resolution = await resolveMcpContext(
      "Bearer ox_cli_session",
      "req-2",
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    await expect(
      assertCallerRole(OWNER_ADMIN_ONLY, resolution.ctx),
    ).rejects.toThrow(/requires org Owner or Admin/);
  });

  it("still admits the same person while she holds the role", async () => {
    cliSessionKeyFor(ALICE);
    orgUsersRole.value = "admin";
    const resolution = await resolveMcpContext(
      "Bearer ox_cli_session",
      "req-3",
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    await expect(
      assertCallerRole(OWNER_ADMIN_ONLY, resolution.ctx),
    ).resolves.toBeUndefined();
  });

  it("records the person on the api_key.used access-log row", async () => {
    // The audit record and the access decision must name the same principal.
    // This row said "nobody" while `assertCallerRole` (on enterprise, via
    // fetch-authz's apiKeyId → created_by_id mapping) decided against Alice.
    const { emitSecurityEvent } = await import("@oxagen/database/security");
    vi.mocked(emitSecurityEvent).mockClear();
    cliSessionKeyFor(ALICE);
    await resolveMcpContext(
      "Bearer ox_cli_session",
      "req-audit",
      "203.0.113.7",
    );
    expect(emitSecurityEvent).toHaveBeenCalledOnce();
    const event = vi.mocked(emitSecurityEvent).mock.calls[0]?.[0];
    expect(event?.eventType).toBe("api_key.used");
    expect(event?.actorUserId).toBe(ALICE);
  });

  it("leaves every other key resolving to no person, exactly as before", async () => {
    cliSessionKeyFor(null);
    const resolution = await resolveMcpContext("Bearer ox_machine", "req-4");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.ctx.userId).toBeNull();
  });
});
