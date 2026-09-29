// The read behind the headless steering backfill (#4683). The filter decides
// which workspaces get a provision event, so these tests render it to SQL and
// assert each condition. The Postgres test in
// packages/handlers/src/repository.pg.test.ts runs it against real rows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  calls: [] as { method: string; args: unknown[] }[],
  rows: [] as unknown[],
}));
vi.mock("@oxagen/database", async (original) => {
  const real = await original<typeof import("@oxagen/database")>();
  // A query builder that records each call and resolves to `mocks.rows`.
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => {
          if (method === "then")
            return (resolve: (rows: unknown[]) => unknown) =>
              resolve(mocks.rows);
          return (...args: unknown[]) => {
            mocks.calls.push({ method, args });
            return chain();
          };
        },
      },
    );
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(chain()),
  };
});

import {
  headlessWorkspaceFilter,
  isWorkspaceArchived,
  listHeadlessWorkspaces,
} from "./steering-repo-backfill";

const dialect = new PgDialect();

const QUEUED_BEFORE = new Date("2026-09-29T11:00:00.000Z");

function render(after: string | null) {
  const where = headlessWorkspaceFilter({ after, queuedBefore: QUEUED_BEFORE });
  if (where === undefined) throw new Error("the filter rendered nothing");
  return dialect.sqlToQuery(where);
}

describe("headless workspace filter", () => {
  it("skips archived workspaces and organizations that are not active", () => {
    const { sql, params } = render(null);
    expect(sql).toContain('"workspaces"."archived_at" is null');
    expect(sql).toContain('"organizations"."status" = $');
    expect(params).toContain("active");
  });

  it("selects a workspace only when it has no steering head", () => {
    const { sql, params } = render(null);
    expect(sql).toMatch(
      /not exists \(select 1 from "ingestion"\."repository_binding_heads" h where h\.workspace_id = "workspace"\."workspaces"\."id" and h\.role in \(\$\d+\)\)/,
    );
    expect(params).toContain("steering");
  });

  it("skips an organization on a dedicated Postgres plane", () => {
    const { sql } = render(null);
    expect(sql).toContain('not exists (select 1 from "org"."data_planes" p');
    expect(sql).toContain("p.mode = 'dedicated'");
    expect(sql).toContain("p.deleted_at is null");
  });

  it("selects no state, a send that failed, or a job that never ran", () => {
    const { sql, params } = render(null);
    // Columns render with their Postgres schema: "workspace"."workspaces".
    const settings = '"workspace"."workspaces"."settings"';
    expect(sql).toContain(
      `(${settings} #>> '{steering_repo,status}' is null or ${settings} #>> '{steering_repo,error,code}' = 'enqueue_failed' or (${settings} #>> '{steering_repo,status}' = 'provisioning' and ${settings} #>> '{steering_repo,step}' is null and ${settings} #>> '{steering_repo,updated_at}' < $`,
    );
    expect(params).toContain(QUEUED_BEFORE.toISOString());
  });

  it("leaves a blocked or failed job alone (negative)", () => {
    const { sql } = render(null);
    expect(sql).not.toContain("'blocked'");
    expect(sql).not.toContain("'failed'");
  });

  it("reads from the start without a cursor", () => {
    const { sql } = render(null);
    expect(sql).not.toContain('"workspaces"."id" > $');
  });

  it("reads after the cursor when one is given", () => {
    const after = "0192d4a8-7c1e-7a00-8000-00000000c0de";
    const { sql, params } = render(after);
    expect(sql).toContain('"workspaces"."id" > $');
    expect(params).toContain(after);
  });
});

describe("listHeadlessWorkspaces", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.rows = [];
  });

  it("reads one page in id order and returns its rows", async () => {
    const row = {
      orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
      workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
      actorUserId: "0192d4a8-7c1e-7a00-8000-0000000005e1",
    };
    mocks.rows = [row];

    await expect(
      listHeadlessWorkspaces({
        after: null,
        queuedBefore: QUEUED_BEFORE,
        limit: 50,
      }),
    ).resolves.toEqual([row]);

    expect(mocks.calls.map((c) => c.method)).toEqual([
      "select",
      "from",
      "innerJoin",
      "where",
      "orderBy",
      "limit",
    ]);
    expect(mocks.calls.at(-1)!.args).toEqual([50]);
    const selected = mocks.calls[0]!.args[0] as Record<string, unknown>;
    expect(Object.keys(selected).sort()).toEqual([
      "actorUserId",
      "orgId",
      "workspaceId",
    ]);
  });
});

describe("isWorkspaceArchived", () => {
  const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
  const WORKSPACE_ID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
  const scope = { orgId: ORG_ID, workspaceId: WORKSPACE_ID };

  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.rows = [];
  });

  it("reads one workspace by its id and its organization", async () => {
    await isWorkspaceArchived(scope);

    expect(mocks.calls.map((c) => c.method)).toEqual([
      "select",
      "from",
      "where",
      "limit",
    ]);
    expect(mocks.calls.at(-1)!.args).toEqual([1]);
    const selected = mocks.calls[0]!.args[0] as Record<string, unknown>;
    expect(Object.keys(selected)).toEqual(["archivedAt"]);
    const where = mocks.calls[2]!.args[0] as Parameters<
      typeof dialect.sqlToQuery
    >[0];
    const { sql, params } = dialect.sqlToQuery(where);
    expect(sql).toContain('"workspaces"."id" = $');
    expect(sql).toContain('"workspaces"."org_id" = $');
    expect(params).toEqual(expect.arrayContaining([WORKSPACE_ID, ORG_ID]));
  });

  it("reads true for an archived workspace", async () => {
    mocks.rows = [{ archivedAt: new Date("2026-09-29T12:00:00.000Z") }];
    await expect(isWorkspaceArchived(scope)).resolves.toBe(true);
  });

  it("reads false for a workspace that is not archived", async () => {
    mocks.rows = [{ archivedAt: null }];
    await expect(isWorkspaceArchived(scope)).resolves.toBe(false);
  });

  it("reads false when no row matches, so the provision steps report it", async () => {
    await expect(isWorkspaceArchived(scope)).resolves.toBe(false);
  });
});
