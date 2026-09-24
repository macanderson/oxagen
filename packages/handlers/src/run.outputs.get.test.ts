/**
 * Unit tests for the get_run_outputs handler.
 *
 * The two stores are the thing under test: a wrapped session's node shape
 * comes from `tacho.session_files` and a ledger run's from its receipts, and
 * the read-versus-write split decides which rows become durable nodes and
 * which become the reads the tally counts apart. The queries are injected, so
 * most cases assert what the handler makes of the rows. The files query is
 * also rendered through `drizzle.mock`, because the column it filters on
 * holds a row id and not the uuid the run resolves to, and a stub keyed on
 * the uuid hid exactly that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@oxagen/database";
import { RUN_OUTPUT_NODE_MAX } from "@oxagen/oxagen/contracts/run.outputs.get";
import {
  postgresRunOutputQueries,
  type RunApprovalRow,
  type RunOutputQueries,
  type SessionFileRow,
} from "./lib/run-outputs";
import { WORK_PR_LINK_CAP } from "./lib/run-work";
import {
  createRunOutputsGetHandler,
  type RunOutputsGetDeps,
} from "./run.outputs.get";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  summary,
  tachoSession,
} from "./run.test-support";

const mocks = vi.hoisted(() => ({
  /** What the shipped files query hands back, and the SQL it was asked. */
  rows: [] as Record<string, unknown>[],
  statements: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const db = drizzle.mock({ schema: real.schema });
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: (fn: (tx: typeof db) => { toSQL(): unknown }) => {
      const query = fn(db).toSQL() as { sql: string; params: unknown[] };
      mocks.statements.push(query);
      return Promise.resolve(mocks.rows);
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

beforeEach(() => {
  mocks.rows = [];
  mocks.statements = [];
});

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
/** The `tacho.sessions` row id, which is what `session_files.session_id` holds. */
const SESSION_ROW_ID = "0192d4a8-7c1e-7000-8000-0000000051d0";
const CHILD_UUID = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
const CHILD_ROW_ID = "0192d4a8-7c1e-7000-8000-0000000051d1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";

/** `tacho.sessions` as the files query joins it: the run's root and one subagent. */
const SESSION_ROWS = [
  { id: SESSION_ROW_ID, sessionUuid: SESSION_UUID, root: SESSION_UUID },
  { id: CHILD_ROW_ID, sessionUuid: CHILD_UUID, root: SESSION_UUID },
];

/** A `session_files` row as stored: keyed on the session's row id. */
type StoredFile = Omit<SessionFileRow, "ownChain"> & { sessionId: string };

function file(over: Partial<StoredFile> & { path: string }): StoredFile {
  return {
    sessionId: SESSION_ROW_ID,
    repoRelativePath: over.path,
    language: null,
    reads: 0,
    writes: 0,
    edits: 0,
    deletes: 0,
    linesAdded: 0,
    linesRemoved: 0,
    observedStatus: null,
    firstSeq: 1,
    lastSeq: 1,
    digestBefore: null,
    digestAfter: null,
    ...over,
  };
}

function harness(opts: {
  files?: StoredFile[];
  events?: ReturnType<typeof event>[];
  approvals?: RunApprovalRow[];
  links?: Awaited<ReturnType<RunOutputsGetDeps["prLinks"]>>;
  /** The PR-link read rejects, as a ClickHouse outage would. */
  linksFail?: boolean;
}) {
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [tachoSession({ publicId: TACHO_ID })],
  );
  const outputs: RunOutputQueries = {
    // The stored rows name the session's row id, so the uuid the handler
    // passes finds them only through the sessions it resolves to, as the
    // shipped query does.
    sessionFiles: (_scope, sessionUuid, limit) => {
      const chains = new Map(
        SESSION_ROWS.filter(
          (row) => row.sessionUuid === sessionUuid || row.root === sessionUuid,
        ).map((row) => [row.id, row.sessionUuid]),
      );
      return Promise.resolve(
        (opts.files ?? [])
          .filter((row) => chains.has(row.sessionId))
          .map(({ sessionId, ...row }) => ({
            ...row,
            ownChain: chains.get(sessionId) === sessionUuid,
          }))
          .slice(0, limit),
      );
    },
    runApprovals: (_scope, _runId, limit) =>
      Promise.resolve((opts.approvals ?? []).slice(0, limit)),
  };
  const deps: RunOutputsGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (publicId) =>
        Promise.resolve(
          publicId === LEDGER_ID
            ? summary({ publicId: LEDGER_ID, runId: RUN_UUID })
            : null,
        ),
      readAttemptEventsSince: memoryEvents(opts.events ?? []),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: () => Promise.resolve([]),
    outputs,
    prLinks: (sessionUuid) =>
      opts.linksFail === true
        ? Promise.reject(new Error("clickhouse unreachable"))
        : Promise.resolve(
            sessionUuid === SESSION_UUID ? (opts.links ?? []) : [],
          ),
  };
  return createRunOutputsGetHandler(deps);
}

describe("get_run_outputs — a wrapped session", () => {
  it("adds a PR node per harness PR link, in frame order", async () => {
    const outputs = harness({
      files: [
        file({ path: "src/a.ts", writes: 1, lastSeq: 10 }),
        file({ path: "src/b.ts", writes: 1, lastSeq: 30 }),
      ],
      links: [
        {
          url: "https://github.com/acme/app/pull/41",
          number: "41",
          repository: "acme/app",
          seq: 20,
          ts: "2026-09-23 10:00:00.000",
        },
        {
          url: "not a url",
          number: "9",
          repository: "acme/app",
          seq: 25,
          ts: "2026-09-23 10:01:00.000",
        },
      ],
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes.map((n) => [n.seq, n.kind, n.name])).toEqual([
      ["10", "file", "src/a.ts"],
      ["20", "pr", "#41"],
      ["30", "file", "src/b.ts"],
    ]);
    expect(out.nodes[1]).toMatchObject({
      where: "acme/app",
      state: "open",
      note: "https://github.com/acme/app/pull/41",
      observedAt: "2026-09-23T10:00:00.000Z",
    });
    expect(out.tally.artifacts).toBe(3);
  });

  it("draws the files without PRs, marked incomplete, when the PR links cannot be read", async () => {
    const outputs = harness({
      files: [file({ path: "src/a.ts", writes: 1, lastSeq: 10 })],
      linksFail: true,
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes.map((n) => [n.kind, n.name])).toEqual([
      ["file", "src/a.ts"],
    ]);
    expect(out.complete).toBe(false);
  });

  it("stops at the PR-link cap and says the spine is incomplete", async () => {
    const links = Array.from({ length: WORK_PR_LINK_CAP + 1 }, (_, i) => ({
      url: `https://github.com/acme/app/pull/${i + 1}`,
      number: String(i + 1),
      repository: "acme/app",
      seq: i + 1,
      ts: "2026-09-23 10:00:00.000",
    }));
    const outputs = harness({ links });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes.filter((n) => n.kind === "pr")).toHaveLength(
      WORK_PR_LINK_CAP,
    );
    expect(out.complete).toBe(false);
  });

  it("splits reads from writes and counts them apart", async () => {
    const outputs = harness({
      files: [
        file({
          path: "src/router.ts",
          language: "ts",
          reads: 2,
          edits: 1,
          linesAdded: 12,
          linesRemoved: 3,
          observedStatus: "modified",
          lastSeq: 40,
        }),
        file({ path: "src/config.ts", reads: 3, lastSeq: 41 }),
      ],
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.source).toBe("wrapped");
    expect(out.nodes.map((n) => [n.kind, n.name, n.state])).toEqual([
      ["file", "src/router.ts", "written"],
      ["read", "src/config.ts", "read"],
    ]);
    expect(out.tally).toEqual({ artifacts: 1, reads: 1, gates: 0 });
    expect(out.complete).toBe(true);
  });

  it("carries the diff stat, the frame and the digests of a written file", async () => {
    const outputs = harness({
      files: [
        file({
          path: "app/page.tsx",
          language: "tsx",
          writes: 1,
          linesAdded: 40,
          linesRemoved: 0,
          observedStatus: "added",
          lastSeq: 118,
          digestBefore: null,
          digestAfter: `sha256:${"b".repeat(64)}`,
        }),
      ],
    });

    const [node] = (await outputs({ runId: TACHO_ID }, ctx())).nodes;

    expect(node).toMatchObject({
      seq: "118",
      kind: "file",
      name: "app/page.tsx",
      nameIsLocator: false,
      where: "tsx",
      state: "created",
      note: "1 write",
      stat: { added: 40, removed: 0 },
      digestAfter: `sha256:${"b".repeat(64)}`,
    });
  });

  it("gives a read no diff stat, whatever the row counted", async () => {
    const outputs = harness({
      files: [
        file({ path: "README.md", reads: 1, linesAdded: 9, linesRemoved: 9 }),
      ],
    });

    const [node] = (await outputs({ runId: TACHO_ID }, ctx())).nodes;

    expect(node?.kind).toBe("read");
    expect(node?.stat).toBeNull();
  });

  it("shows a generated asset as media, so a surface can show it", async () => {
    const outputs = harness({
      files: [file({ path: "public/chart.png", writes: 1 })],
    });

    expect((await outputs({ runId: TACHO_ID }, ctx())).nodes[0]?.kind).toBe(
      "media",
    );
  });

  it("reads a subagent's paths after the run's own, with no frame of the run's", async () => {
    const outputs = harness({
      files: [
        file({ path: "src/a.ts", writes: 1, lastSeq: 40 }),
        file({
          sessionId: CHILD_ROW_ID,
          path: "src/b.ts",
          edits: 1,
          lastSeq: 3,
        }),
      ],
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes.map((n) => [n.name, n.seq])).toEqual([
      ["src/a.ts", "40"],
      // Frame 3 is the subagent chain's, and the run's frame 3 is another.
      ["src/b.ts", null],
    ]);
    expect(out.tally.artifacts).toBe(2);
  });

  it("keeps a subagent's paths after the run's own PR nodes", async () => {
    const outputs = harness({
      files: [
        file({ path: "src/a.ts", writes: 1, lastSeq: 10 }),
        file({
          sessionId: CHILD_ROW_ID,
          path: "src/b.ts",
          edits: 1,
          lastSeq: 3,
        }),
      ],
      links: [
        {
          url: "https://github.com/acme/app/pull/41",
          number: "41",
          repository: "acme/app",
          seq: 20,
          ts: "2026-09-23 10:00:00.000",
        },
      ],
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes.map((n) => [n.seq, n.kind, n.name])).toEqual([
      ["10", "file", "src/a.ts"],
      ["20", "pr", "#41"],
      [null, "file", "src/b.ts"],
    ]);
  });

  it("says a spine cut at its cap is a prefix", async () => {
    const outputs = harness({
      files: Array.from({ length: RUN_OUTPUT_NODE_MAX + 1 }, (_, i) =>
        file({ path: `src/f${i}.ts`, writes: 1, lastSeq: i + 1 }),
      ),
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes).toHaveLength(RUN_OUTPUT_NODE_MAX);
    expect(out.complete).toBe(false);
  });
});

describe("get_run_outputs — a ledger run", () => {
  it("names a change by its locator and says the name is one", async () => {
    const outputs = harness({
      events: [
        event(1, {
          eventType: "change.recorded",
          payload: {
            path_locator_public_id: "rpl_0123456789abcdefghjkmn",
            change_kind: "modify",
            before_digest: `sha256:${"c".repeat(64)}`,
            after_digest: `sha256:${"d".repeat(64)}`,
          },
        }),
      ],
    });

    const out = await outputs({ runId: LEDGER_ID }, ctx());

    expect(out.source).toBe("ledger");
    expect(out.nodes[0]).toMatchObject({
      seq: "1",
      kind: "change",
      name: "rpl_0123456789abcdefghjkmn",
      nameIsLocator: true,
      state: "written",
      digestBefore: `sha256:${"c".repeat(64)}`,
    });
    expect(out.tally.artifacts).toBe(1);
  });

  it("carries the commit and the pull request the run published", async () => {
    const outputs = harness({
      events: [
        event(2, {
          eventType: "provider_publish.commit_created",
          payload: {
            provider_repository_id: "prp_0123456789abcdefghjkmn",
            commit_sha: "9f2c1ab",
            tree_sha: "0d41c3f",
            changed_file_count: 3,
          },
        }),
        event(3, {
          eventType: "provider_publish.pull_request_opened",
          payload: {
            provider_repository_id: "prp_0123456789abcdefghjkmn",
            pull_request_number: 482,
            head_commit_sha: "9f2c1ab",
          },
        }),
      ],
    });

    const out = await outputs({ runId: LEDGER_ID }, ctx());

    expect(out.nodes.map((n) => [n.kind, n.name, n.state])).toEqual([
      ["commit", "9f2c1ab", "pushed"],
      ["pr", "#482", "open"],
    ]);
    expect(out.nodes[0]?.note).toBe("3 files changed");
    expect(out.tally).toEqual({ artifacts: 2, reads: 0, gates: 0 });
  });

  it("leaves a frame that produced nothing off the spine", async () => {
    const outputs = harness({ events: [event(1), event(2)] });

    const out = await outputs({ runId: LEDGER_ID }, ctx());

    expect(out.nodes).toEqual([]);
    expect(out.tally).toEqual({ artifacts: 0, reads: 0, gates: 0 });
    expect(out.complete).toBe(true);
  });

  const changes = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      event(i + 1, {
        eventType: "change.recorded",
        payload: {
          path_locator_public_id: "rpl_0123456789abcdefghjkmn",
          change_kind: "modify",
          before_digest: `sha256:${"c".repeat(64)}`,
          after_digest: `sha256:${"d".repeat(64)}`,
        },
      }),
    );

  it("says a spine that ends exactly at the cap is complete", async () => {
    const outputs = harness({ events: changes(RUN_OUTPUT_NODE_MAX) });

    const out = await outputs({ runId: LEDGER_ID }, ctx());

    expect(out.nodes).toHaveLength(RUN_OUTPUT_NODE_MAX);
    expect(out.complete).toBe(true);
  });

  it("says a spine cut at its cap is a prefix", async () => {
    const outputs = harness({ events: changes(RUN_OUTPUT_NODE_MAX + 1) });

    const out = await outputs({ runId: LEDGER_ID }, ctx());

    expect(out.nodes).toHaveLength(RUN_OUTPUT_NODE_MAX);
    expect(out.complete).toBe(false);
  });
});

describe("get_run_outputs — a run that produced nothing", () => {
  it("answers an empty spine and a zero tally", async () => {
    const out = await harness({})({ runId: TACHO_ID }, ctx());

    expect(out).toEqual({
      runId: TACHO_ID,
      source: "wrapped",
      nodes: [],
      tally: { artifacts: 0, reads: 0, gates: 0 },
      complete: true,
    });
  });
});

describe("get_run_outputs — a governed gate", () => {
  const parked: RunApprovalRow = {
    publicId: "apr_0123456789abcdefghjkmn",
    capabilityName: "open_pull_request",
    createdAt: new Date("2026-09-11T09:04:00.000Z"),
    resolution: null,
  };

  it("sits after the frames, carries no frame, and names what did not run", async () => {
    const outputs = harness({
      files: [file({ path: "src/a.ts", writes: 1, lastSeq: 7 })],
      approvals: [parked],
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes.map((n) => n.kind)).toEqual(["file", "gate", "would"]);
    expect(out.nodes[1]).toMatchObject({
      seq: null,
      name: "open_pull_request",
      state: "awaiting",
    });
    expect(out.nodes[2]).toMatchObject({ seq: null, state: "withheld" });
    // A gate is not a thing the run produced.
    expect(out.tally).toEqual({ artifacts: 1, reads: 0, gates: 1 });
  });

  it("marks a refused call blocked", async () => {
    const outputs = harness({
      approvals: [{ ...parked, resolution: "denied" }],
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes[0]).toMatchObject({
      kind: "gate",
      state: "blocked",
      note: "the call was denied",
    });
  });

  it("draws nothing for a gate somebody approved", async () => {
    const outputs = harness({
      approvals: [{ ...parked, resolution: "approved" }],
    });

    const out = await outputs({ runId: TACHO_ID }, ctx());

    expect(out.nodes).toEqual([]);
    expect(out.tally.gates).toBe(0);
  });
});

describe("get_run_outputs — the files query", () => {
  const scope = {
    orgId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
    workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000f2",
  };

  it("finds the run's files through tacho.sessions, never by the uuid on session_id", async () => {
    await postgresRunOutputQueries.sessionFiles(scope, SESSION_UUID, 10);

    const [query] = mocks.statements;
    // `session_files.session_id` holds the sessions row id. Comparing it to
    // the run's session uuid matched nothing, so every wrapped run read empty.
    expect(query?.sql).not.toMatch(/"session_files"\."session_id" = \$\d+/);
    expect(query?.sql).toMatch(
      /inner join "tacho"\."sessions" on \("tacho"\."sessions"\."id" = "tacho"\."session_files"\."session_id"/,
    );
    expect(query?.sql).toMatch(
      /\("tacho"\."sessions"\."session_uuid" = \$\d+ or "tacho"\."sessions"\."root_session_uuid" = \$\d+\)/,
    );
    // Both tables are fenced to the workspace, not left to RLS.
    for (const table of ["sessions", "session_files"]) {
      expect(query?.sql).toContain(`"tacho"."${table}"."org_id" = $`);
      expect(query?.sql).toContain(`"tacho"."${table}"."workspace_id" = $`);
    }
    expect(query?.params).toContain(SESSION_UUID);
    expect(query?.params).toContain(scope.orgId);
    expect(query?.params).toContain(scope.workspaceId);
  });

  it("tells the run's own chain from a subagent's", async () => {
    mocks.rows = [
      { ...file({ path: "src/a.ts" }), chain: SESSION_UUID },
      { ...file({ path: "src/b.ts" }), chain: CHILD_UUID },
    ];

    const rows = await postgresRunOutputQueries.sessionFiles(
      scope,
      SESSION_UUID,
      10,
    );

    expect(rows.map((row) => [row.path, row.ownChain])).toEqual([
      ["src/a.ts", true],
      ["src/b.ts", false],
    ]);
    expect(rows[0]).not.toHaveProperty("chain");
  });
});
