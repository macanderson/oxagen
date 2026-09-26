// create_enrollment_token refuses a retired agent before it writes a token.
// onboarding.pg.test.ts covers the issue-and-present path against Postgres.
import type { CapabilityContext } from "@oxagen/oxagen";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...original, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async () => "Owner",
}));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { tachoEnrollmentTokenCreateHandler } from "./tacho.enrollment_token.create";

const CONTEXT: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "00000000-0000-0000-0000-0000000000aa",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const AGENT = {
  id: "agent-uuid",
  publicId: "agt_1",
  slug: "reviewer",
  agentType: "custom",
  status: "active",
  harness: "claude-code",
  orgNamespace: "acme",
  workspaceNamespace: "core",
};

/** A transaction whose agent read answers `agent`, and whose insert records its values. */
function db(agent: Record<string, unknown> | undefined): void {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const read = {
        from: () => read,
        innerJoin: () => read,
        where: () => read,
        limit: async () => (agent ? [agent] : []),
      };
      return fn({
        select: () => read,
        insert: (table: unknown) => {
          mocks.insert(table);
          return {
            values: () => ({
              returning: async () => [{ publicId: "tet_1" }],
            }),
          };
        },
      });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("create_enrollment_token", () => {
  it("issues a token for a live agent", async () => {
    db(AGENT);
    const out = await tachoEnrollmentTokenCreateHandler(
      { agentId: "agt_1", ttlMinutes: 30 },
      CONTEXT,
    );
    expect(out.tokenId).toBe("tet_1");
    expect(out.agentKey).toBe("acme.core.reviewer");
    expect(out.token).toMatch(/^oxe_1time_/);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("refuses a retired (archived) agent and writes no token", async () => {
    db({ ...AGENT, status: "archived" });
    await expect(
      tachoEnrollmentTokenCreateHandler(
        { agentId: "agt_1", ttlMinutes: 30 },
        CONTEXT,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_retired",
      message: 'Agent "reviewer" is retired',
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  // #4350: stella runs inside Oxagen as the built-in assistant, so no host
  // may enroll as it.
  it("refuses the built-in assistant and writes no token", async () => {
    db({ ...AGENT, slug: "qa-chat", agentType: "interactive_chat" });
    await expect(
      tachoEnrollmentTokenCreateHandler(
        { agentId: "agt_1", ttlMinutes: 30 },
        CONTEXT,
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "agent_managed_read_only",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers agent_not_found for an agent that is not in the workspace", async () => {
    db(undefined);
    await expect(
      tachoEnrollmentTokenCreateHandler(
        { agentId: "agt_missing", ttlMinutes: 30 },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "agent_not_found" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
