import { describe, it, expect, vi, beforeEach } from "vitest";

import { PgDialect } from "drizzle-orm/pg-core";
const queries = vi.hoisted(() => ({
  predicates: [] as import("drizzle-orm").SQL[],
  shared: [{ id: "notification-1" }],
}));
beforeEach(() => {
  vi.clearAllMocks();
  queries.predicates.length = 0;
  queries.shared = [{ id: "notification-1" }];
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = {
    ...real,
    withTenantDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({
          set: () => ({
            where: (predicate: import("drizzle-orm").SQL) => {
              queries.predicates.push(predicate);
              return { returning: () => Promise.resolve(queries.shared) };
            },
          }),
        }),
      }),
    ),
  };
  return {
    ...dbMock,
    withOrgDb: vi.fn(dbMock.withTenantDb.getMockImplementation()),
  };
});

import { withOrgDb, withTenantDb } from "@oxagen/database";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import { handler } from "./notification.mark";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

describe("notifications.mark handler", () => {
  it("returns ok:true when marking as read", async () => {
    const result = await handler({ id: "ntf_abc", read: true }, ctx);
    expect(result).toEqual({ ok: true });
    expect(withOrgDb).toHaveBeenCalled();
    expect(withTenantDb).not.toHaveBeenCalled();
    const dialect = new PgDialect();
    const statements = queries.predicates.map((predicate) =>
      dialect.sqlToQuery(predicate),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain('"workspace_id" is null');
    for (const statement of statements) {
      expect(statement.params).toEqual(["ntf_abc", "user-1", "org-1"]);
    }
  });

  it("returns ok:true when archiving", async () => {
    const result = await handler({ id: "ntf_abc", archived: true }, ctx);
    expect(result).toEqual({ ok: true });
  });

  it("throws when userId is absent", async () => {
    const noUserCtx = { ...ctx, userId: null };
    await expect(
      handler({ id: "ntf_abc", read: true }, noUserCtx),
    ).rejects.toThrow("userId is required");
  });

  it("returns ok:true with no-op when neither read nor archived provided", async () => {
    const result = await handler({ id: "ntf_abc" }, ctx);
    expect(result).toEqual({ ok: true });
  });
});

it("falls back to the workspace seam when no shared notification matches", async () => {
  queries.shared = [];
  await handler({ id: "ntf_workspace", read: true }, ctx);
  expect(withOrgDb).toHaveBeenCalledTimes(1);
  expect(withTenantDb).toHaveBeenCalledTimes(1);
  const predicate = queries.predicates[1];
  expect(predicate).toBeDefined();
  if (!predicate) throw new Error("Missing workspace update");
  const statement = new PgDialect().sqlToQuery(predicate);
  expect(statement.params).toEqual(["ntf_workspace", "user-1", "org-1"]);
});

it("does not enter the tenant seam for an organization-only call", async () => {
  queries.shared = [];
  await handler(
    { id: "ntf_missing", read: true },
    { ...ctx, workspaceId: ORG_ONLY_WORKSPACE_ID },
  );
  expect(withOrgDb).toHaveBeenCalledTimes(1);
  expect(withTenantDb).not.toHaveBeenCalled();
});
