// ingest.test.ts
//
// Exercises ingestBenchResultsDir against the real fixture directory
// (__fixtures__/sample-run/ — a small, hand-built stand-in for a Harbor
// results dir) with @oxagen/telemetry/bench-client mocked directly:
// chBenchInsert/chBenchQuery are @oxagen/bench's only ClickHouse-touching
// dependency (see ingest.ts's header comment for why).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type {
  BenchmarkCandidateRow,
  BenchmarkRunResultRow,
  BenchmarkRunRow,
} from "./types";

const insertMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@oxagen/telemetry/bench-client", () => ({
  chBenchInsert: insertMock,
  chBenchQuery: queryMock,
}));

const FIXTURE_DIR = join(__dirname, "__fixtures__", "sample-run");

/** Default query mock: no existing run found, public_id counters start at 0 (so the next id is 1). */
function mockEmptyDatabase(): void {
  queryMock.mockReset();
  queryMock.mockImplementation(async (query: string) => {
    if (query.includes("WHERE bench_type")) return [];
    if (query.includes("max(public_id)")) return [{ m: "0" }];
    return [];
  });
}

function insertedTable(table: string): { table: string; values: unknown[] } {
  const call = insertMock.mock.calls.find((c) => c[0] === table);
  if (!call) throw new Error(`no insert call for table ${table}`);
  return { table: call[0] as string, values: call[1] as unknown[] };
}

describe("ingestBenchResultsDir", () => {
  let mod: typeof import("./ingest");

  beforeEach(async () => {
    insertMock.mockClear();
    insertMock.mockResolvedValue(undefined);
    mockEmptyDatabase();
    vi.resetModules();
    mod = await import("./ingest");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("parses the fixture dir into one run row, one row per finished task, and one row per candidate", async () => {
    const summary = await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123", // overrides bench-config.json's "snapshot-sha-000"
      config: { models: ["a", "b"] }, // merges with bench-config.json's {candidates: 2, effort: "high"}
      conditions: { os: "linux" }, // overrides bench-config.json's conditions.os, keeps docker_vm
      costUsd: 12.34,
    });

    // task-four-incomplete has no result.json — skipped, not fatal.
    expect(summary.alreadyIngested).toBe(false);
    expect(summary.nTasks).toBe(5);
    expect(summary.nResolved).toBe(2); // task-one (reward 1) + task-three (reward 1, no report.json)
    expect(summary.skipped).toEqual([
      {
        taskId: "task-four-incomplete__jkl012",
        reason: "no result.json (trial did not finish)",
      },
    ]);
    expect(insertMock).toHaveBeenCalledTimes(3);
  });

  it("assigns public_id = max+1 and writes the merged secret-free config/conditions onto the run row", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
      config: { models: ["a", "b"] },
      conditions: { os: "linux" },
      costUsd: 12.34,
      notes: "backfill test",
    });

    const runRow = insertedTable("bench.benchmark_run")
      .values[0] as BenchmarkRunRow;
    expect(runRow.public_id).toBe(1);
    expect(runRow.bench_type).toBe("swe-bench");
    expect(runRow.agent).toBe("oxagen"); // derived from config.json's "oxagen_swe_bench:OxagenAgent"
    expect(runRow.dataset).toBe("swe-bench/swe-bench-verified");
    expect(runRow.git_sha).toBe("abc123");
    expect(runRow.n_tasks).toBe(5);
    expect(runRow.n_resolved).toBe(2);
    expect(runRow.resolved_rate).toBeCloseTo(2 / 5);
    expect(runRow.total_cost_usd).toBe(12.34);
    expect(runRow.notes).toBe("backfill test");
    // Skipped a task -> "partial", not "completed".
    expect(runRow.status).toBe("partial");

    // config: options.config merged OVER the bench-config.json snapshot.
    expect(JSON.parse(runRow.config)).toEqual({
      candidates: 2,
      effort: "high",
      models: ["a", "b"],
    });
    // conditions: options.conditions.os overrides the snapshot's, docker_vm survives from the snapshot.
    expect(JSON.parse(runRow.conditions)).toEqual({
      docker_vm: "VZ",
      os: "linux",
    });
  });

  it("derives resolved/reward/test_spec from the verifier report when present", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });

    const results = insertedTable("bench.benchmark_run_result")
      .values as BenchmarkRunResultRow[];
    const taskOne = results.find((r) => r.task_id === "task-one")!;
    expect(taskOne.public_id).toBe(1);
    expect(taskOne.resolved).toBe(1);
    expect(taskOne.reward).toBe(1);
    expect(JSON.parse(taskOne.test_spec)).toEqual({
      FAIL_TO_PASS: ["test_ascii_validator"],
      PASS_TO_PASS: ["test_help_text", "test_validate"],
    });
    expect(taskOne.problem_statement).toBe(
      "Fix the trailing newline bug in the username validator.",
    );
    expect(taskOne.n_candidates).toBe(2);
    expect(taskOne.winner_candidate_id).toBe("candidate-1");
    expect(taskOne.winner_files).toBe(1);
    expect(taskOne.winner_steps).toBe(5);

    // Aggregated across both candidates: candidate-1 {read_file,code_graph,edit_file,bash},
    // candidate-2 {read_file,grep,edit_file,bash,bash}.
    expect(JSON.parse(taskOne.tool_calls_json)).toEqual({
      read_file: 2,
      code_graph: 1,
      edit_file: 2,
      bash: 3,
      grep: 1,
    });
    expect(taskOne.code_graph_calls).toBe(1);
    expect(taskOne.grep_calls).toBe(1);

    // Token/cost capture: oxagen reports one undifferentiated total in
    // agent_result.metadata.oxagen_total_tokens (not the input/output/cache
    // split), plus a real agent_result.cost_usd. tokens_total carries the
    // metadata total; the split columns stay 0 (oxagen never populates them).
    expect(taskOne.tokens_total).toBe(506956);
    expect(taskOne.tokens_in).toBe(0);
    expect(taskOne.tokens_out).toBe(0);
    expect(taskOne.tokens_cache).toBe(0);
    expect(taskOne.cost_usd).toBe(1.62);

    const expectedDuration = Math.round(
      (Date.parse("2026-07-03T21:29:50.872754Z") -
        Date.parse("2026-07-03T21:27:00.997829Z")) /
        1000,
    );
    expect(taskOne.duration_s).toBe(expectedDuration);

    const taskTwo = results.find((r) => r.task_id === "task-two-unresolved")!;
    expect(taskTwo.resolved).toBe(0);
    expect(taskTwo.reward).toBe(0);
    expect(taskTwo.tokens_total).toBe(812345);
    expect(taskTwo.cost_usd).toBe(3.08);
  });

  it("degrades gracefully when a task has a result.json but no trajectory or verifier report", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });

    const results = insertedTable("bench.benchmark_run_result")
      .values as BenchmarkRunResultRow[];
    const taskThree = results.find(
      (r) => r.task_id === "task-three-no-trajectory",
    )!;
    // No verifier/report.json -> falls back to reward >= 1.
    expect(taskThree.reward).toBe(1);
    expect(taskThree.resolved).toBe(1);
    // No agent/oxagen.txt -> empty trajectory, not a thrown error.
    expect(taskThree.problem_statement).toBe("");
    expect(taskThree.n_candidates).toBe(0);
    expect(JSON.parse(taskThree.tool_calls_json)).toEqual({});
  });

  it("writes one benchmark_candidate row per trajectory candidate, correctly flagging the winner", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });

    const candidates = insertedTable("bench.benchmark_candidate")
      .values as BenchmarkCandidateRow[];
    // task-one: 2, task-two: 3, task-three: 0 (no trajectory), task-six: 1 => 6 total.
    expect(candidates).toHaveLength(6);

    const taskOneCandidates = candidates.filter(
      (c) => c.candidate_id.startsWith("candidate-") && c.steps <= 6,
    );
    const winner = candidates.find((c) => c.is_winner === 1 && c.steps === 5)!;
    expect(winner.model).toBe("anthropic/claude-fable-5");
    expect(winner.files_changed).toBe(1);
    expect(winner.tests_passed).toBe(-1); // not explicitly failed -> unknown, not a real pass/fail signal
    expect(taskOneCandidates.length).toBeGreaterThan(0);

    const failedCandidate = candidates.find(
      (c) => c.steps === 3 && c.files_changed === 0,
    )!;
    expect(failedCandidate.tests_passed).toBe(0); // failed: true in the trajectory
    expect(failedCandidate.is_winner).toBe(0);
  });

  it("handles an errored task: exception_info, real token counts, no task_name/task_id, no agent_execution, a corrupt verifier report, and empty bestof-N metadata falling back to the trajectory", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });

    const results = insertedTable("bench.benchmark_run_result")
      .values as BenchmarkRunResultRow[];
    // No task_name/task_id in result.json -> bareTaskId() is "" -> falls back to the directory name.
    const taskSix = results.find(
      (r) => r.task_id === "task-six-errored__pqr678",
    )!;
    expect(taskSix.status).toBe("errored");
    expect(JSON.parse(taskSix.error)).toEqual({
      exception_type: "AgentTimeoutError",
      message: "agent exceeded wall-clock budget",
    });
    // Real (non-null) token counts flow straight through.
    expect(taskSix.tokens_in).toBe(1000);
    expect(taskSix.tokens_out).toBe(300);
    expect(taskSix.tokens_cache).toBe(200);
    // No oxagen_total_tokens metadata (competitor-shaped result) -> tokens_total
    // falls back to the sum of the split fields, per agentTotalTokens().
    expect(taskSix.tokens_total).toBe(1500);
    // No agent_execution block -> falls back to the trial-level started_at/finished_at.
    expect(taskSix.duration_s).toBe(
      Math.round(
        (Date.parse("2026-07-03T21:55:00.000000Z") -
          Date.parse("2026-07-03T21:50:00.000000Z")) /
          1000,
      ),
    );
    // agent_result.metadata is {} (no oxagen_bestofn_* fields) -> falls back to the trajectory's
    // own winner/candidate data instead of reporting all-zero.
    expect(taskSix.n_candidates).toBe(1);
    expect(taskSix.winner_candidate_id).toBe("candidate-1");
    expect(taskSix.winner_files).toBe(1);
    // verifier/report.json is corrupt (unparseable) -> readJsonOptional swallows the parse error and
    // returns null -> falls back to the reward-based resolved computation (reward 0 here) rather than throwing.
    expect(taskSix.resolved).toBe(0);
    expect(JSON.parse(taskSix.test_spec)).toEqual({
      FAIL_TO_PASS: [],
      PASS_TO_PASS: [],
    });

    // The run-level split totals include task-six's real counts (every other fixture task has null split fields).
    const runRow = insertedTable("bench.benchmark_run")
      .values[0] as BenchmarkRunRow;
    expect(runRow.tokens_in).toBe(1000);
    expect(runRow.tokens_out).toBe(300);
    expect(runRow.tokens_cache).toBe(200);
    // tokens_total sums every task's authoritative total: task-one 506956 +
    // task-two 812345 + task-six 1500 (split sum) + task-three/task-seven 0.
    expect(runRow.tokens_total).toBe(506956 + 812345 + 1500);
  });

  it("sums per-task agent_result.cost_usd into total_cost_usd when no out-of-band costUsd is supplied", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });
    const runRow = insertedTable("bench.benchmark_run")
      .values[0] as BenchmarkRunRow;
    // task-one 1.62 + task-two 3.08 + task-three/six/seven (null -> 0).
    expect(runRow.total_cost_usd).toBeCloseTo(4.7, 5);
  });

  it("handles a run with zero finished tasks, no run-level result.json, and an explicit status override", async () => {
    const ALL_SKIPPED_DIR = join(__dirname, "__fixtures__", "all-skipped-run");
    const summary = await mod.ingestBenchResultsDir(ALL_SKIPPED_DIR, {
      benchType: "terminal-bench",
      status: "failed",
    });

    expect(summary.nTasks).toBe(0);
    expect(summary.nResolved).toBe(0);
    expect(summary.skipped).toEqual([
      {
        taskId: "only-task__aaa111",
        reason: "no result.json (trial did not finish)",
      },
    ]);

    const runRow = insertedTable("bench.benchmark_run")
      .values[0] as BenchmarkRunRow;
    // No result.json at the run level -> defaulted to "now" rather than thrown.
    expect(runRow.started_at).toBeTruthy();
    expect(runRow.finished_at).toBe(runRow.started_at);
    // Empty config.json agents/datasets -> "unknown" agent, "" dataset (no options override supplied).
    expect(runRow.agent).toBe("unknown");
    expect(runRow.dataset).toBe("");
    expect(runRow.git_sha).toBe(""); // no options.gitSha and no bench-config.json snapshot
    expect(runRow.n_tasks).toBe(0);
    expect(runRow.resolved_rate).toBe(0); // divide-by-zero guarded, not NaN
    // options.status explicitly overrides the skipped-derived "partial" default.
    expect(runRow.status).toBe("failed");
  });

  it("falls back to the bench-config.json snapshot's git sha when options.gitSha is omitted", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, { benchType: "swe-bench" });
    const runRow = insertedTable("bench.benchmark_run")
      .values[0] as BenchmarkRunRow;
    expect(runRow.git_sha).toBe("snapshot-sha-000");
  });

  it("defaults a task's started_at/finished_at to the run's own start when it has no timestamps of its own", async () => {
    await mod.ingestBenchResultsDir(FIXTURE_DIR, { benchType: "swe-bench" });
    const results = insertedTable("bench.benchmark_run_result")
      .values as BenchmarkRunResultRow[];
    const taskSeven = results.find(
      (r) => r.task_id === "task-seven-no-timestamps",
    )!;
    const runRow = insertedTable("bench.benchmark_run")
      .values[0] as BenchmarkRunRow;
    // No agent_execution, no trial-level started_at/finished_at -> falls all the way back
    // to the run's own started_at (from the run-level result.json) — compared against the
    // run row's own (identically-derived) value rather than a hardcoded literal, since the
    // fixture's timestamp has no "Z"/offset and Date.parse of a naive string is timezone-dependent.
    expect(taskSeven.started_at).toBe(runRow.started_at);
    expect(taskSeven.finished_at).toBe(runRow.started_at);
    expect(taskSeven.duration_s).toBe(0);
  });

  it("uses a run with zero skipped tasks to confirm the default status is 'completed'", async () => {
    // Ingest only the run's well-formed tasks by pre-seeding an existing-run match for nothing
    // and instead pointing at a directory with no incomplete task — reuse FIXTURE_DIR's own
    // config/result but assert on a task-bearing status only when nothing was skipped.
    // (sample-run always has one incomplete task; this run has none.)
    const ALL_COMPLETE_DIR = join(
      __dirname,
      "__fixtures__",
      "all-complete-run",
    );
    await mod.ingestBenchResultsDir(ALL_COMPLETE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });
    const runRow = insertedTable("bench.benchmark_run")
      .values[0] as BenchmarkRunRow;
    expect(runRow.status).toBe("completed");
  });

  it("skips ingestion and reports the existing public_id when a matching run already exists", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (query: string) => {
      if (query.includes("WHERE bench_type")) return [{ public_id: "7" }];
      return [{ m: "0" }];
    });

    const summary = await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });
    expect(summary.alreadyIngested).toBe(true);
    expect(summary.runPublicId).toBe(7);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("re-ingests despite a matching existing run when force: true is passed", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (query: string) => {
      if (query.includes("WHERE bench_type")) return [{ public_id: "7" }];
      if (query.includes("max(public_id)")) return [{ m: "7" }];
      return [];
    });

    const summary = await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
      force: true,
    });
    expect(summary.alreadyIngested).toBe(false);
    expect(summary.runPublicId).toBe(8);
    expect(insertMock).toHaveBeenCalledTimes(3);
  });

  it("treats a native-number max(public_id) the same as ClickHouse's usual quoted-string form", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (query: string) => {
      if (query.includes("WHERE bench_type")) return [];
      if (query.includes("max(public_id)")) return [{ m: 9 }]; // number, not "9"
      return [];
    });
    const summary = await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });
    expect(summary.runPublicId).toBe(10);
  });

  it("starts numbering at 1 when max(public_id) returns no rows at all (a genuinely empty table)", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (query: string) => {
      if (query.includes("WHERE bench_type")) return [];
      if (query.includes("max(public_id)")) return []; // zero rows, not even {m: 0}
      return [];
    });
    const summary = await mod.ingestBenchResultsDir(FIXTURE_DIR, {
      benchType: "swe-bench",
      gitSha: "abc123",
    });
    expect(summary.runPublicId).toBe(1);
  });

  it("refuses to ingest when config carries a likely secret value, before any insert happens", async () => {
    await expect(
      mod.ingestBenchResultsDir(FIXTURE_DIR, {
        benchType: "swe-bench",
        gitSha: "abc123",
        config: { apiKey: "sk-ant-leaked-value" },
      }),
    ).rejects.toThrow(/likely secret/);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("refuses to ingest when conditions carries a likely secret value", async () => {
    await expect(
      mod.ingestBenchResultsDir(FIXTURE_DIR, {
        benchType: "swe-bench",
        gitSha: "abc123",
        conditions: { authToken: "leaked-value-not-an-env-name" },
      }),
    ).rejects.toThrow(/likely secret/);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("insertBenchmarkRun / insertBenchmarkRunResults / insertBenchmarkCandidates", () => {
  beforeEach(async () => {
    insertMock.mockClear();
    insertMock.mockResolvedValue(undefined);
    mockEmptyDatabase();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // The empty-array no-op itself lives in chBenchInsert now (see
  // bench-client.test.ts "no-ops on an empty rows array") — these wrappers
  // just forward whatever they're given.
  it("insertBenchmarkRunResults / insertBenchmarkCandidates forward straight through to chBenchInsert", async () => {
    const mod = await import("./ingest");
    await mod.insertBenchmarkRunResults([]);
    await mod.insertBenchmarkCandidates([]);
    expect(insertMock).toHaveBeenCalledWith("bench.benchmark_run_result", []);
    expect(insertMock).toHaveBeenCalledWith("bench.benchmark_candidate", []);
  });

  it("insertBenchmarkRun always inserts a single row against bench.benchmark_run", async () => {
    const mod = await import("./ingest");
    const row: BenchmarkRunRow = {
      id: "r1",
      public_id: 1,
      bench_type: "swe-bench",
      dataset: "d",
      agent: "oxagen",
      git_sha: "sha",
      config: "{}",
      conditions: "{}",
      n_tasks: 0,
      n_resolved: 0,
      resolved_rate: 0,
      total_cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache: 0,
      tokens_total: 0,
      status: "completed",
      notes: "",
      started_at: "2026-07-03 00:00:00",
      finished_at: "2026-07-03 00:00:00",
    };
    await mod.insertBenchmarkRun(row);
    expect(insertMock).toHaveBeenCalledWith("bench.benchmark_run", [row]);
  });
});
