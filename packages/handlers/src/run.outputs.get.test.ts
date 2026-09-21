/**
 * Unit tests for the get_run_outputs handler.
 *
 * The two stores are the thing under test: a wrapped session's node shape
 * comes from `tacho.session_files` and a ledger run's from its receipts, and
 * the read-versus-write split decides which rows become durable nodes and
 * which become the reads the tally counts apart. The queries are injected, so
 * what is asserted is what the handler makes of the rows; their SQL is the
 * Postgres suite's job.
 */
import { describe, expect, it } from "vitest";
import { RUN_OUTPUT_NODE_MAX } from "@oxagen/oxagen/contracts/run.outputs.get";
import type {
  RunApprovalRow,
  RunOutputQueries,
  SessionFileRow,
} from "./lib/run-outputs";
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

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";

function file(
  over: Partial<SessionFileRow> & { path: string },
): SessionFileRow {
  return {
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
  files?: SessionFileRow[];
  events?: ReturnType<typeof event>[];
  approvals?: RunApprovalRow[];
}) {
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [tachoSession({ publicId: TACHO_ID })],
  );
  const outputs: RunOutputQueries = {
    sessionFiles: (_scope, sessionUuid, limit) =>
      Promise.resolve(
        sessionUuid === SESSION_UUID ? (opts.files ?? []).slice(0, limit) : [],
      ),
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
  };
  return createRunOutputsGetHandler(deps);
}

describe("get_run_outputs — a wrapped session", () => {
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
