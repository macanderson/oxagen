/**
 * `list_tacho_sessions` refuses a cursor it did not mint, and
 * `get_tacho_session` fences every read to the caller's workspace.
 *
 * The cursor's id is compared with a uuid column, so an id that is not a uuid
 * failed in Postgres as a 500 rather than as the caller's mistake. The session
 * read's child, model, file, command, incident and checkpoint reads named the
 * session alone and left the workspace to RLS, which a local stack runs with
 * bypassed. The where clauses are read off the fake transaction and rendered
 * through the Postgres dialect.
 */
import type { CapabilityContext } from "@oxagen/oxagen";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...original, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { tachoSessionGetHandler } from "./tacho.session.get";
import { tachoSessionListHandler } from "./tacho.session.list";

const CTX: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-0000000000a1",
  workspaceId: "00000000-0000-4000-8000-0000000000b2",
  userId: "00000000-0000-4000-8000-0000000000c3",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
const SESSION_UUID = "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b";
const SESSION_ROW_ID = "3f2b7a5e-8c1d-4e6f-9a0b-00000000051d";

const dialect = new PgDialect();

/** Every where clause the handler built, by the table it read. */
let reads: Array<{ table: string; where: SQL }>;

function tableName(table: unknown): string {
  for (const symbol of Object.getOwnPropertySymbols(table as object)) {
    if (symbol.description === "drizzle:Name")
      return (table as Record<symbol, string>)[symbol] ?? "?";
  }
  return "?";
}

function relational(table: string, first: unknown, many: unknown[] = []) {
  return {
    findFirst: async ({ where }: { where: SQL }) => {
      reads.push({ table, where });
      return first;
    },
    findMany: async ({ where }: { where: SQL }) => {
      reads.push({ table, where });
      return many;
    },
  };
}

beforeEach(() => {
  reads = [];
  const session = {
    id: SESSION_ROW_ID,
    sessionUuid: SESSION_UUID,
    hostId: null,
    startedAt: new Date("2026-09-08T10:06:03.000Z"),
    lastEventAt: new Date("2026-09-08T10:06:30.000Z"),
    endedAt: null,
    completenessGaps: [],
  };
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // The column probe: every column these reads may name is present.
        execute: async () => [{ "?column?": 1 }],
        query: {
          tachoSessions: relational("sessions", session, [session]),
          tachoSessionModels: relational("session_models", undefined),
          tachoSessionFiles: relational("session_files", undefined),
          tachoSessionCommands: relational("session_commands", undefined),
          tachoIncidents: relational("incidents", undefined),
          tachoHosts: relational("hosts", undefined),
        },
        select: () => ({
          from: (table: unknown) => ({
            where: async (where: SQL) => {
              reads.push({ table: tableName(table), where });
              return [{ value: 0 }];
            },
          }),
        }),
      }),
  );
});

const cursor = (text: string) =>
  Buffer.from(text, "utf8").toString("base64url");

describe("list_tacho_sessions — a cursor it did not mint", () => {
  it("refuses a cursor whose id is not a uuid as invalid input, before any read", async () => {
    await expect(
      tachoSessionListHandler(
        {
          limit: 50,
          includeChildren: false,
          cursor: cursor("2026-09-08T10:06:03.000Z|not-a-uuid"),
        },
        CTX,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "invalid_cursor",
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses a cursor that does not decode (negative)", async () => {
    await expect(
      tachoSessionListHandler(
        { limit: 50, includeChildren: false, cursor: "garbage" },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("pages from a cursor it minted", async () => {
    const out = await tachoSessionListHandler(
      {
        limit: 1,
        includeChildren: false,
        cursor: cursor(`2026-09-08T10:06:03.000Z|${SESSION_ROW_ID}`),
      },
      CTX,
    );

    expect(out.sessions).toHaveLength(1);
    const { params } = dialect.sqlToQuery(reads[0]?.where as SQL);
    expect(params).toContain(SESSION_ROW_ID);
  });
});

describe("get_tacho_session — the reads under one session", () => {
  it("names the caller's org and workspace on every read, not the session alone", async () => {
    await tachoSessionGetHandler({ sessionUuid: SESSION_UUID }, CTX);

    const tables = reads.map((read) => read.table);
    expect(tables).toEqual(
      expect.arrayContaining([
        "sessions",
        "session_models",
        "session_files",
        "session_commands",
        "incidents",
        "checkpoints",
      ]),
    );
    for (const read of reads) {
      const { sql, params } = dialect.sqlToQuery(read.where);
      expect(sql, read.table).toContain(`"${read.table}"."org_id" = $`);
      expect(sql, read.table).toContain(`"${read.table}"."workspace_id" = $`);
      expect(params, read.table).toContain(CTX.orgId);
      expect(params, read.table).toContain(CTX.workspaceId);
    }
    // The child read is the session's children, not the whole workspace.
    const children = reads.filter((read) => read.table === "sessions")[1];
    expect(dialect.sqlToQuery(children?.where as SQL).params).toContain(
      SESSION_UUID,
    );
  });
});
