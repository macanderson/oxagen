// enroll_host refuses a token whose agent was deleted or retired after the
// token was issued. onboarding.pg.test.ts covers the full enrollment against
// Postgres. Here the host mint is stubbed, so the test can show the refusal
// mints no host and leaves the token unused.
import type { CapabilityContext } from "@oxagen/oxagen";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  mintHostEnrollment: vi.fn(),
  enrollmentDocument: vi.fn(),
  requireEnrollmentSigning: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...original,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./lib/tacho-host-enroll", () => ({
  mintHostEnrollment: mocks.mintHostEnrollment,
  enrollmentDocument: mocks.enrollmentDocument,
  requireEnrollmentSigning: mocks.requireEnrollmentSigning,
}));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { tachoHostEnrollHandler } from "./tacho.host.enroll";

const CONTEXT: CapabilityContext = {
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const INPUT = {
  token: `oxe_1time_${"A".repeat(26)}`,
  hostname: "Mac-Studio.local",
  osUser: "dev",
  platform: "darwin" as const,
  devicePublicKey: `ed25519:${Buffer.alloc(32, 7).toString("base64")}`,
  harnesses: ["claude-code" as const],
  managed: false,
  validityDays: 30,
} as Parameters<typeof tachoHostEnrollHandler>[0];

const TOKEN = {
  id: "token-uuid",
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  issuedToUserId: "00000000-0000-0000-0000-0000000000aa",
  expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  usedAt: null,
};

const AGENT = {
  id: "agent-uuid",
  publicId: "agt_1",
  slug: "reviewer",
  status: "active",
  principalId: "prn-agent",
  orgNamespace: "acme",
  orgSlug: "acme",
  workspaceNamespace: "core",
  workspaceSlug: "core",
};

/** Updates the tenant transaction issued. The only one marks the token used. */
let tenantUpdates = 0;

/**
 * The token read answers TOKEN. Inside the tenant transaction the reads
 * answer, in order: the locked token row, the agent (or none), and no
 * existing host.
 */
function db(agent: Record<string, unknown> | undefined): void {
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const read = {
        from: () => read,
        where: () => read,
        limit: async () => [TOKEN],
      };
      return fn({
        select: () => read,
        update: () => ({ set: () => ({ where: async () => [] }) }),
      });
    },
  );
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const answers: unknown[][] = [
        [{ usedAt: null, agentId: "agent-uuid" }],
        agent ? [agent] : [],
        [],
      ];
      const next = async () => answers.shift() ?? [];
      const read = {
        from: () => read,
        innerJoin: () => read,
        where: () => read,
        limit: next,
        for: next,
      };
      return fn({
        select: () => read,
        update: () => {
          tenantUpdates += 1;
          return { set: () => ({ where: async () => [] }) };
        },
      });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantUpdates = 0;
  mocks.requireEnrollmentSigning.mockReturnValue({ secret: "s" });
  mocks.mintHostEnrollment.mockResolvedValue({
    host: { id: "host-uuid", agentKey: "acme.core.reviewer" },
    hostEnrollmentId: "tch_1",
  });
  mocks.enrollmentDocument.mockReturnValue({ hostEnrollmentId: "tch_1" });
});

describe("enroll_host", () => {
  it("enrolls a host for a live agent and marks the token used", async () => {
    db(AGENT);
    const out = await tachoHostEnrollHandler(INPUT, CONTEXT);
    expect(out.agentId).toBe("agt_1");
    expect(mocks.mintHostEnrollment).toHaveBeenCalledTimes(1);
    expect(tenantUpdates).toBe(1);
  });

  it("refuses a token whose agent was retired (archived) after it was issued", async () => {
    db({ ...AGENT, status: "archived" });
    await expect(tachoHostEnrollHandler(INPUT, CONTEXT)).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_retired",
      message: 'Agent "reviewer" is retired',
    });
    expect(mocks.mintHostEnrollment).not.toHaveBeenCalled();
    // The token keeps `used_at` null: nothing marked it used.
    expect(tenantUpdates).toBe(0);
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a token whose agent was deleted, with the same reason", async () => {
    db(undefined);
    await expect(tachoHostEnrollHandler(INPUT, CONTEXT)).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_retired",
      message: "The agent this token was issued for no longer exists",
    });
    expect(mocks.mintHostEnrollment).not.toHaveBeenCalled();
    expect(tenantUpdates).toBe(0);
  });
});
