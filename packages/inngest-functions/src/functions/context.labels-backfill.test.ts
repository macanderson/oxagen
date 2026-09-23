import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getScope } from "@oxagen/tenancy";

const mocks = vi.hoisted(() => ({
  rows: [] as {
    id: string;
    orgId: string;
    workspaceId: string;
    slug: string;
  }[],
  writes: [] as { label: string; where: unknown; scope: unknown }[],
}));
vi.mock("@oxagen/database", async (original) => {
  const real = await original<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: () => Promise.resolve(mocks.rows) }),
            }),
          }),
        }),
      }),
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        update: () => ({
          set: (value: { label: string }) => ({
            where: (where: unknown) => {
              mocks.writes.push({ ...value, where, scope: getScope() });
              return Promise.resolve();
            },
          }),
        }),
      }),
  };
});
vi.mock("../create-function", () => ({
  createFunction: (_options: unknown, _trigger: unknown, handler: unknown) => [
    handler,
  ],
}));
import { contextLabelsBackfill } from "./context.labels-backfill";

const run = () =>
  (
    contextLabelsBackfill as unknown as (ctx: {
      step: { run: (id: string, fn: () => unknown) => unknown };
    }) => Promise<unknown>
  )({ step: { run: (_id, fn) => fn() } });

beforeEach(() => {
  mocks.rows.length = 0;
  mocks.writes.length = 0;
});
describe("context label backfill", () => {
  it("does nothing when there are no missing labels", async () => {
    expect(await run()).toEqual({ processed: 0 });
    expect(mocks.writes).toEqual([]);
  });
  it("scopes every update and protects a label filled after the scan", async () => {
    const row = {
      id: "0192d4a8-7c1e-7a00-8000-000000000001",
      orgId: "0192d4a8-7c1e-7a00-8000-000000000002",
      workspaceId: "0192d4a8-7c1e-7a00-8000-000000000003",
      slug: "release-checklist",
    };
    mocks.rows.push(row);
    expect(await run()).toEqual({ processed: 1 });
    expect(mocks.writes[0]).toMatchObject({
      label: "Release Checklist",
      scope: { orgId: row.orgId, workspaceId: row.workspaceId },
    });
    const query = new PgDialect().sqlToQuery(
      mocks.writes[0]!.where as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(query.sql).toContain('"label" is null');
    expect(query.sql).toContain('"deleted_at" is null');
    expect(query.params).toEqual([row.id, row.orgId, row.workspaceId]);
  });
});
