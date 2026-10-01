/**
 * get_auto_eligibility and an approval the in-app assistant parked (ADR-235,
 * ruled on 2026-10-01), asserted on the statement the relational read issues.
 *
 * Such a row belongs to the person who asked. For anyone else the read
 * matches nothing, so the handler answers `not_found`, the answer an approval
 * in another workspace gets. The recorded evaluation and the approver are
 * covered against Postgres in approval_rule.handlers.pg.test.ts. The rows
 * the predicate keeps are proven in @oxagen/rules approval-in-app.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  resolveActingUserId: vi.fn(
    async (ctx: { userId: string | null }) => ctx.userId,
  ),
  assertOrgRole: vi.fn(async () => "Member"),
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: mocks.resolveActingUserId,
  assertOrgRole: mocks.assertOrgRole,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a suite that counts seam calls must see one identity.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { schema } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen";
import { approvalAutoEligibilityGetHandler } from "./approval.auto_eligibility.get";
import { makeCTX } from "./test-utils/fixtures";

const ASKER = "0192d4a8-7c1e-7a00-8000-0000000000f3";
const APPROVAL = "apr_0123456789abcdefghjkmn";

const statements: Array<{ sql: string; params: unknown[] }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  // drizzle's own proxy driver renders the statement the handler would send
  // and answers no rows.
  const db = drizzle(
    async (sql, params) => {
      statements.push({ sql, params });
      return { rows: [] };
    },
    { schema },
  );
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(db)),
  );
});

const notFound = (e: unknown) =>
  isHandlerError(e) && e.code === "not_found" && e.reason === "approval_not_found";

describe("get_auto_eligibility: an approval the in-app assistant parked", () => {
  it("reads an in-app row only for the person who asked, and answers not_found otherwise", async () => {
    await expect(
      approvalAutoEligibilityGetHandler(
        { approvalId: APPROVAL },
        makeCTX({ userId: ASKER }),
      ),
    ).rejects.toSatisfy(notFound);
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ASKER }),
      { org: ["Owner", "Admin", "Member"] },
    );
    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0]!;
    expect(sql).toMatch(/from "agent"\."approval_requests" "approvalRequests"/);
    // The row's own columns follow the relational read's alias. The run's
    // and the message's columns keep theirs.
    expect(sql).toContain(
      '(not exists (select 1 from "agent"."agent_runs" as "in_app_run" where "in_app_run"."public_id" = "approvalRequests"."run_public_id"::citext',
    );
    expect(sql).toContain(
      'or exists (select 1 from "chat"."messages" as "asker_message"',
    );
    expect(sql).toContain(
      '"asker_message"."id" = "approvalRequests"."message_id"',
    );
    expect(sql).toMatch(/"asker_conversation"\."user_id" = \$\d+/);
    expect(params).toEqual(
      expect.arrayContaining([APPROVAL, ASKER, "chat", "api-chat"]),
    );
  });

  it("shows no in-app row to a caller with no acting user (negative)", async () => {
    await expect(
      approvalAutoEligibilityGetHandler(
        { approvalId: APPROVAL },
        makeCTX({ userId: null, apiKeyId: null }),
      ),
    ).rejects.toSatisfy(notFound);
    const { sql } = statements[0]!;
    expect(sql).toContain(
      'not exists (select 1 from "agent"."agent_runs" as "in_app_run"',
    );
    expect(sql).not.toContain('"chat"."messages"');
  });
});
