// list_interjections (#3839): the cursor codec and the row mapping are pure;
// the page's WHERE is read back through the Postgres dialect, so the tenant
// fence, the open predicate, the run filter and the page boundary are
// asserted as SQL; and the handler is run against a recorded transaction for
// the page size and the cursor it hands back.
//
// The table has no migration on this branch (the integrator writes it), so
// the Postgres-backed block below runs only where DATABASE_URL names a
// database that carries `agent.interjections`, which CI's `test` job does
// once the migration lands.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { interjectBodySchema } from "@oxagen/tacho";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn(), useReal: false }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = (fn: (tx: unknown) => unknown) =>
    mocks.useReal ? real.withTenantDb(fn as never) : mocks.withTenantDb(fn);
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});

import { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
import {
  agentInterjectionListHandler,
  decodeInterjectionCursor,
  encodeInterjectionCursor,
  type InterjectionListRow,
  interjectionListWhere,
  toInterjectionListItem,
} from "./agent.interjection.list";
import { makeCTX } from "./test-utils/fixtures";

const dialect = new PgDialect();
const where = (cond: SQL | undefined) =>
  cond === undefined ? { sql: "", params: [] } : dialect.sqlToQuery(cond);

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const SCOPE = { orgId: ORG, workspaceId: WS };

function row(over: Partial<InterjectionListRow> = {}): InterjectionListRow {
  return {
    publicId: "inj_0123456789abcdefghjkmn",
    runPublicId: "tse_0123456789abcdefghjkmn",
    agentKey: "acme.core.release-bot",
    question: "Which branch should the release cut from?",
    raisedAt: new Date("2026-09-25T09:00:00.000Z"),
    expiresAt: new Date("2026-09-25T09:30:00.000Z"),
    answeredAt: null,
    answer: null,
    answeredByPublicId: null,
    kind: "question",
    raisedSeq: null,
    body: null,
    repository: null,
    path: null,
    receiptId: null,
    ...over,
  };
}

/** A host's `control.interject` body, as the ingest copies it onto the row. */
const BODY = interjectBodySchema.parse({
  interjection_key: "01K6Z000000000000000000000",
  reason: "repo_unknown",
  question: "Link this repository to core, or create a workspace for it?",
  remote_digest: `sha256:${"e".repeat(64)}`,
  timeout_ms: 1_800_000,
  expires_at: "2026-09-25T09:30:00.000Z",
  on_timeout: "deny",
  paths: [
    {
      path: "link",
      workspace_slug: "core",
      config_version: "skl_v2",
      skills_pinned: 3,
      linked_repositories: 1,
    },
    {
      path: "create",
      proposed_name: "api",
      proposed_slug: "api",
      skills_enabled: false,
    },
  ],
});

/** A transaction whose select chain records the WHERE and the limit, and answers `rows`. */
function recording(rows: InterjectionListRow[]) {
  const seen: { where?: SQL; limit?: number } = {};
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: (cond: SQL) => {
      seen.where = cond;
      return chain;
    },
    orderBy: () => chain,
    limit: (n: number) => {
      seen.limit = n;
      return Promise.resolve(rows);
    },
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ select: () => chain })),
  );
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useReal = false;
});

describe("list_interjections cursor", () => {
  it("round-trips the last row's expiry and public id", () => {
    const r = row();
    expect(decodeInterjectionCursor(encodeInterjectionCursor(r))).toEqual({
      expiresAt: r.expiresAt,
      id: r.publicId,
    });
  });

  it("starts over on a cursor it did not mint (negative)", () => {
    expect(decodeInterjectionCursor(undefined)).toBeUndefined();
    expect(decodeInterjectionCursor("")).toBeUndefined();
    expect(decodeInterjectionCursor("not-a-cursor")).toBeUndefined();
    expect(
      decodeInterjectionCursor(
        Buffer.from("yesterday|inj_x").toString("base64url"),
      ),
    ).toBeUndefined();
    expect(
      decodeInterjectionCursor(
        Buffer.from("2026-09-25T09:30:00.000Z|inj_x|extra").toString(
          "base64url",
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses a signed year Date.parse accepts and Postgres does not (negative)", () => {
    // Before, this passed the Date.parse guard and reached the query as
    // '-000001-01-01T00:00:00.000Z'::timestamptz, which Postgres refuses: a 500.
    expect(
      decodeInterjectionCursor(
        Buffer.from("-000001-01-01T00:00:00.000Z|inj_x").toString("base64url"),
      ),
    ).toBeUndefined();
  });
});

describe("list_interjections refuses a cursor it did not mint", () => {
  it("answers invalid_cursor instead of the first page (negative)", async () => {
    const seen = recording([row()]);
    const attempt = agentInterjectionListHandler(
      agentInterjectionList.input.parse({
        cursor: Buffer.from("-000001-01-01T00:00:00.000Z|inj_x").toString(
          "base64url",
        ),
      }),
      makeCTX({ orgId: ORG, workspaceId: WS }),
    );
    await expect(attempt).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("invalid_cursor"),
    });
    expect(seen.limit).toBeUndefined();
  });
});

describe("list_interjections item", () => {
  it("carries an open question with null for every answer field, and reads a row from before #3941 as a question", () => {
    expect(toInterjectionListItem(row())).toEqual({
      id: "inj_0123456789abcdefghjkmn",
      runId: "tse_0123456789abcdefghjkmn",
      agentKey: "acme.core.release-bot",
      question: "Which branch should the release cut from?",
      raisedAt: "2026-09-25T09:00:00.000Z",
      expiresAt: "2026-09-25T09:30:00.000Z",
      answeredAt: null,
      answer: null,
      answeredBy: null,
      kind: "question",
      raisedSeq: null,
      body: null,
      repository: null,
      path: null,
      receiptId: null,
    });
  });

  it("carries a repository question's frame, body, repository, path and receipt, and parses through the contract", () => {
    const item = toInterjectionListItem(
      row({
        question: BODY.question,
        kind: "repo_unknown",
        raisedSeq: 7,
        body: BODY,
        repository: "acme/api",
        answeredAt: new Date("2026-09-25T09:04:00.000Z"),
        answer: "Linked acme/api to the workspace core.",
        answeredByPublicId: "usr_0123456789abcdefghjkmn",
        path: "link",
        receiptId: "rcp_0123456789abcdefghjkmn",
      }),
    );
    expect(item).toMatchObject({
      kind: "repo_unknown",
      raisedSeq: "7",
      body: BODY,
      repository: "acme/api",
      path: "link",
      receiptId: "rcp_0123456789abcdefghjkmn",
    });
    expect(
      agentInterjectionList.output.parse({ items: [item], nextCursor: null }),
    ).toEqual({ items: [item], nextCursor: null });
  });

  it("reads a stored body that drifted from its schema as null, so the page still parses (negative)", () => {
    const item = toInterjectionListItem(
      row({ kind: "repo_unknown", body: { ...BODY, reason: "curious" } }),
    );
    expect(item.body).toBeNull();
    expect(() =>
      agentInterjectionList.output.parse({ items: [item], nextCursor: null }),
    ).not.toThrow();
  });

  it("reads the timeout's deny, which no person gave", () => {
    const item = toInterjectionListItem(
      row({
        kind: "repo_unknown",
        body: BODY,
        answeredAt: new Date("2026-09-25T09:30:00.000Z"),
        answer: "Nobody answered before the deadline. The session went on without skills.",
        path: "deny",
        receiptId: "rcp_0123456789abcdefghjkmn",
      }),
    );
    expect(item).toMatchObject({ path: "deny", answeredBy: null });
  });

  it("carries the answer, when it was given and who gave it, and parses through the contract", () => {
    const item = toInterjectionListItem(
      row({
        answeredAt: new Date("2026-09-25T09:04:00.000Z"),
        answer: "main",
        answeredByPublicId: "usr_0123456789abcdefghjkmn",
      }),
    );
    expect(
      agentInterjectionList.output.parse({ items: [item], nextCursor: null }),
    ).toEqual({ items: [item], nextCursor: null });
    expect(item.answeredAt).toBe("2026-09-25T09:04:00.000Z");
    expect(item.answer).toBe("main");
    expect(item.answeredBy).toBe("usr_0123456789abcdefghjkmn");
  });
});

describe("list_interjections WHERE", () => {
  it("fences the read to the caller's org and workspace", () => {
    const q = where(interjectionListWhere({ open: false }, SCOPE, undefined));
    expect(q.sql).toMatch(/"org_id" = \$/);
    expect(q.sql).toMatch(/"workspace_id" = \$/);
    expect(q.params).toEqual(expect.arrayContaining([ORG, WS]));
  });

  it("lists only unanswered, unexpired questions when open, and every question otherwise", () => {
    const open = where(interjectionListWhere({ open: true }, SCOPE, undefined));
    expect(open.sql).toMatch(/"answered_at" is null/);
    expect(open.sql).toMatch(/"expires_at" > now\(\)/);
    const all = where(interjectionListWhere({ open: false }, SCOPE, undefined));
    expect(all.sql).not.toMatch(/"answered_at"/);
    expect(all.sql).not.toMatch(/now\(\)/);
  });

  it("narrows to one run when the caller names one", () => {
    const q = where(
      interjectionListWhere(
        { open: true, runId: "arun_0123456789abcdefghjkmn" },
        SCOPE,
        undefined,
      ),
    );
    expect(q.sql).toMatch(/"run_public_id" = \$/);
    expect(q.params).toContain("arun_0123456789abcdefghjkmn");
  });

  it("starts after the cursor: a later expiry, or the same expiry and a greater id", () => {
    const q = where(
      interjectionListWhere({ open: true }, SCOPE, {
        expiresAt: new Date("2026-09-25T09:30:00.000Z"),
        id: "inj_0123456789abcdefghjkmn",
      }),
    );
    expect(q.sql).toMatch(
      /date_trunc\('milliseconds', "agent"\."interjections"\."expires_at"\) > /,
    );
    expect(q.sql).toMatch(/"public_id" > \$/);
    expect(q.params).toEqual(
      expect.arrayContaining([
        "2026-09-25T09:30:00.000Z",
        "inj_0123456789abcdefghjkmn",
      ]),
    );
  });
});

describe("list_interjections handler", () => {
  it("reads one more row than the page to know whether another page follows, and mints its cursor from the last row shown", async () => {
    const rows = [
      row({
        publicId: "inj_a",
        expiresAt: new Date("2026-09-25T09:10:00.000Z"),
      }),
      row({
        publicId: "inj_b",
        expiresAt: new Date("2026-09-25T09:20:00.000Z"),
      }),
      row({
        publicId: "inj_c",
        expiresAt: new Date("2026-09-25T09:30:00.000Z"),
      }),
    ];
    const seen = recording(rows);
    const out = await agentInterjectionListHandler(
      agentInterjectionList.input.parse({ limit: 2 }),
      makeCTX({ orgId: ORG, workspaceId: WS }),
    );
    expect(seen.limit).toBe(3);
    expect(out.items.map((i) => i.id)).toEqual(["inj_a", "inj_b"]);
    expect(decodeInterjectionCursor(out.nextCursor ?? undefined)).toEqual({
      expiresAt: new Date("2026-09-25T09:20:00.000Z"),
      id: "inj_b",
    });
    const q = where(seen.where);
    expect(q.sql).toMatch(/"answered_at" is null/);
    expect(q.params).toEqual(expect.arrayContaining([ORG, WS]));
  });

  it("hands back no cursor on the last page", async () => {
    recording([row()]);
    const out = await agentInterjectionListHandler(
      agentInterjectionList.input.parse({}),
      makeCTX({ orgId: ORG, workspaceId: WS }),
    );
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "list_interjections against Postgres",
  async () => {
    const { schema, withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { inArray } = await import("drizzle-orm");

    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const wsA1 = crypto.randomUUID();
    const wsA2 = crypto.randomUUID();
    const NOW = Date.now();
    const at = (minutes: number) => new Date(NOW + minutes * 60_000);
    const ids: Record<string, string> = {};

    const list = (
      orgId: string,
      workspaceId: string,
      input: Parameters<typeof agentInterjectionList.input.parse>[0] = {},
    ) =>
      runInTenantScope({ orgId, workspaceId }, () =>
        agentInterjectionListHandler(
          agentInterjectionList.input.parse(input),
          makeCTX({ orgId, workspaceId, userId: null }),
        ),
      );

    beforeAll(async () => {
      mocks.useReal = true;
      await withSystemDb(async (tx) => {
        const base = {
          orgId: orgA,
          workspaceId: wsA1,
          runPublicId: "tse_0123456789abcdefghjkmn",
          raisedAt: at(-5),
        };
        const rows = await tx
          .insert(schema.interjections)
          .values([
            { ...base, question: "soonest", expiresAt: at(10) },
            { ...base, question: "later", expiresAt: at(25) },
            {
              ...base,
              question: "other run",
              runPublicId: "arun_0123456789abcdefghjkmn",
              expiresAt: at(20),
            },
            {
              ...base,
              question: "answered",
              expiresAt: at(15),
              answeredAt: at(-1),
              answer: "yes",
            },
            {
              ...base,
              question: "expired",
              raisedAt: at(-40),
              expiresAt: at(-10),
            },
            {
              ...base,
              workspaceId: wsA2,
              question: "other workspace",
              expiresAt: at(5),
            },
            { ...base, orgId: orgB, question: "other org", expiresAt: at(5) },
          ])
          .returning({
            publicId: schema.interjections.publicId,
            question: schema.interjections.question,
          });
        for (const r of rows) ids[r.question] = r.publicId;
      });
    });

    afterAll(async () => {
      mocks.useReal = false;
      await withSystemDb((tx) =>
        tx
          .delete(schema.interjections)
          .where(inArray(schema.interjections.orgId, [orgA, orgB])),
      );
    });

    beforeEach(() => {
      mocks.useReal = true;
    });

    it("lists this workspace's open questions, soonest expiry first", async () => {
      const out = agentInterjectionList.output.parse(await list(orgA, wsA1));
      expect(out.items.map((i) => i.question)).toEqual([
        "soonest",
        "other run",
        "later",
      ]);
      expect(out.nextCursor).toBeNull();
    });

    it("lists answered and expired questions too when open is false", async () => {
      const out = await list(orgA, wsA1, { open: false });
      expect(out.items.map((i) => i.question).sort()).toEqual(
        ["answered", "expired", "later", "other run", "soonest"].sort(),
      );
    });

    it("narrows to one run", async () => {
      const out = await list(orgA, wsA1, {
        runId: "arun_0123456789abcdefghjkmn",
      });
      expect(out.items.map((i) => i.id)).toEqual([ids["other run"]]);
    });

    it("pages without a gap or a duplicate", async () => {
      const first = await list(orgA, wsA1, { limit: 2 });
      const second = await list(orgA, wsA1, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect([...first.items, ...second.items].map((i) => i.question)).toEqual([
        "soonest",
        "other run",
        "later",
      ]);
      expect(second.nextCursor).toBeNull();
    });
  },
);
