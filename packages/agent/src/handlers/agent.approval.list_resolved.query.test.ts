import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: (fn: (tx: unknown) => unknown) =>
    fn({ query: { approvalRequests: { findMany } } }),
}));
import { agentApprovalListResolvedHandler } from "./agent.approval.list_resolved";

it.each(["succeeded", "failed", "indeterminate"])(
  "selects and returns %s execution evidence through the relational projection",
  async (status) => {
    findMany.mockImplementation(async ({ columns }) => {
      expect(columns).toMatchObject({
        resumeStatus: true,
        resumeRunPublicId: true,
        resumeError: true,
      });
      const stored = {
        publicId: "apr_test",
        capabilityName: "write_test",
        createdAt: new Date(0),
        expiresAt: new Date(60000),
        resolvedAt: new Date(1000),
        resolution: "approved",
        resolvedByPolicy: null,
        runPublicId: "arun_original",
        ruleIds: [],
        autoRuleId: null,
        resolvedReasons: [],
        resumeStatus: status,
        resumeRunPublicId: "arun_resumed",
        resumeError: status === "succeeded" ? null : "kill_switch_active",
      };
      return [
        Object.fromEntries(
          Object.entries(stored).filter(([key]) => columns[key]),
        ),
      ];
    });
    const out = await agentApprovalListResolvedHandler(
      { limit: 10 },
      {
        orgId: "org",
        workspaceId: "ws",
        userId: "user",
        apiKeyId: null,
        requestId: "request",
        surface: "app",
        messageId: null,
      },
    );
    expect(out.items[0]?.execution).toEqual({
      status,
      runId: "arun_resumed",
      reason: status === "succeeded" ? null : "kill_switch_active",
    });
  },
);

const CTX = {
  orgId: "org",
  workspaceId: "ws",
  userId: "user",
  apiKeyId: null,
  requestId: "request",
  surface: "app" as const,
  messageId: null,
};

/** The WHERE the handler hands the relational read, rendered. */
async function renderedWhere(input: { limit: number; runId?: string }) {
  let where: SQL | undefined;
  findMany.mockImplementation(async (config: { where: SQL }) => {
    where = config.where;
    return [];
  });
  await agentApprovalListResolvedHandler(input, CTX);
  return new PgDialect().sqlToQuery(where!);
}

// ADR-235, ruled on 2026-10-01: an approval the in-app assistant parked
// belongs to the person who asked. The rows are proven against Postgres in
// agent.approval.list_resolved.test.ts. These pin the read on every run.
it("leaves every in-app approval out of the workspace's history", async () => {
  const { sql, params } = await renderedWhere({ limit: 10 });
  expect(sql).toMatch(
    /not exists \(select 1 from "agent"\."agent_runs" as "in_app_run"/,
  );
  expect(sql).not.toContain('"chat"."messages"');
  expect(params).toEqual(expect.arrayContaining(["chat", "api-chat"]));
});

it("under a run, keeps an in-app approval only for the person who asked", async () => {
  const { sql, params } = await renderedWhere({
    limit: 10,
    runId: "arun_0123456789abcdefghjkmn",
  });
  expect(sql).toMatch(/"run_public_id" = \$\d+/);
  expect(sql).toMatch(
    /\(not exists \(select 1 from "agent"\."agent_runs".* or exists \(select 1 from "chat"\."messages" as "asker_message"/,
  );
  expect(sql).toMatch(/"asker_conversation"\."user_id" = \$\d+/);
  expect(params).toEqual(
    expect.arrayContaining(["arun_0123456789abcdefghjkmn", "user"]),
  );
});
