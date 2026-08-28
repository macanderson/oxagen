/**
 * The internal bench list/replay commands — proves list/replay render
 * correctly, --json is machine-readable, and --run shells out to the right
 * script with the right env and reports its exit code. ./query and
 * ./replay-env are mocked, plus node:child_process/node:fs, so nothing
 * touches a real database, filesystem, or process.
 */
import { EventEmitter } from "node:events";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { BenchmarkRunResultRow, BenchmarkRunRow } from "./types";

vi.mock("./query", () => ({
  listBenchResults: vi.fn(),
  getBenchResultByPublicId: vi.fn(),
  getBenchRunByPublicId: vi.fn(),
}));
vi.mock("./replay-env", () => ({
  buildReplayEnv: vi.fn(),
  formatEnvPrefix: vi.fn(),
  runScriptFor: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

import { handleBenchList, handleBenchReplay } from "./commands";
import {
  getBenchResultByPublicId,
  getBenchRunByPublicId,
  listBenchResults,
} from "./query";
import { buildReplayEnv, formatEnvPrefix, runScriptFor } from "./replay-env";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const mockListBenchResults = listBenchResults as unknown as Mock;
const mockGetBenchResultByPublicId =
  getBenchResultByPublicId as unknown as Mock;
const mockGetBenchRunByPublicId = getBenchRunByPublicId as unknown as Mock;
const mockBuildReplayEnv = buildReplayEnv as unknown as Mock;
const mockFormatEnvPrefix = formatEnvPrefix as unknown as Mock;
const mockRunScriptFor = runScriptFor as unknown as Mock;
const mockSpawn = spawn as unknown as Mock;
const mockExistsSync = existsSync as unknown as Mock;

let stdout = "";
let stderr = "";
let writeOut: typeof process.stdout.write;
let writeErr: typeof process.stderr.write;

beforeEach(() => {
  stdout = "";
  stderr = "";
  writeOut = process.stdout.write.bind(process.stdout);
  writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = 0;
  vi.clearAllMocks();
  mockFormatEnvPrefix.mockReturnValue('OXAGEN_EFFORT="xhigh"');
  mockRunScriptFor.mockReturnValue("bench/swe-bench/run.sh");
  mockBuildReplayEnv.mockReturnValue({ OXAGEN_EFFORT: "xhigh" });
});

afterEach(() => {
  process.stdout.write = writeOut;
  process.stderr.write = writeErr;
  process.exitCode = 0;
});

function resultRow(
  overrides: Partial<BenchmarkRunResultRow> = {},
): BenchmarkRunResultRow {
  return {
    id: "r1",
    public_id: 2984,
    run_id: "run1",
    run_public_id: 3,
    bench_type: "swe-bench",
    dataset: "swe-bench/swe-bench-verified",
    task_id: "django__django-11099",
    task_source: "swe-bench-verified",
    problem_statement: "Fix the bug.",
    gold_patch: "",
    test_spec: "{}",
    config: '{"effort":"xhigh"}',
    model_patch: "",
    n_candidates: 3,
    winner_candidate_id: "candidate-1",
    winner_files: 1,
    winner_steps: 8,
    tool_calls_json: "{}",
    code_graph_calls: 1,
    grep_calls: 0,
    reward: 1,
    resolved: 1,
    verifier_stdout: "",
    cost_usd: 4.2,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache: 0,
    tokens_total: 506956,
    duration_s: 120,
    status: "completed",
    error: "",
    started_at: "2026-07-03 14:26:34",
    finished_at: "2026-07-03 14:36:48",
    ...overrides,
  };
}

function runRow(overrides: Partial<BenchmarkRunRow> = {}): BenchmarkRunRow {
  return {
    id: "run1",
    public_id: 3,
    bench_type: "swe-bench",
    dataset: "swe-bench/swe-bench-verified",
    agent: "oxagen",
    git_sha: "abc1234",
    config: "{}",
    conditions: "{}",
    n_tasks: 4,
    n_resolved: 2,
    resolved_rate: 0.5,
    total_cost_usd: 12,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache: 0,
    tokens_total: 1319301,
    status: "partial",
    notes: "",
    started_at: "2026-07-03 14:26:34",
    finished_at: "2026-07-03 14:40:00",
    ...overrides,
  };
}

describe("handleBenchList", () => {
  it("renders a table of results, newest first, truncating a long task id", async () => {
    mockListBenchResults.mockResolvedValue([
      resultRow({ public_id: 2, task_id: "a".repeat(40) }),
      resultRow({ public_id: 1, resolved: 0, reward: 0 }),
    ]);
    await handleBenchList({});
    expect(stdout).toContain("#2");
    expect(stdout).toContain("#1");
    expect(stdout).toContain("…"); // the 40-char task id got truncated
    expect(stdout).toContain("yes");
    expect(stdout).toContain("no");
    expect(stdout).toContain("tokens"); // the token column header
    expect(stdout).toContain("507.0k"); // tokens_total 506956 rendered compactly
  });

  it("passes the type filter and a parsed numeric limit through", async () => {
    mockListBenchResults.mockResolvedValue([]);
    await handleBenchList({ type: "terminal-bench", limit: "5" });
    expect(mockListBenchResults).toHaveBeenCalledWith({
      benchType: "terminal-bench",
      limit: 5,
    });
  });

  it("passes limit: undefined when the limit string doesn't parse to a finite number", async () => {
    mockListBenchResults.mockResolvedValue([]);
    await handleBenchList({ limit: "not-a-number" });
    expect(mockListBenchResults).toHaveBeenCalledWith({
      benchType: undefined,
      limit: undefined,
    });
  });

  it("prints a no-results message, mentioning the type filter when one was given", async () => {
    mockListBenchResults.mockResolvedValue([]);
    await handleBenchList({ type: "swe-bench" });
    expect(stdout).toContain("No bench results found");
    expect(stdout).toContain("swe-bench");
  });

  it("emits JSON with --json", async () => {
    const rows = [resultRow()];
    mockListBenchResults.mockResolvedValue(rows);
    await handleBenchList({ json: true });
    expect(JSON.parse(stdout)).toEqual(rows);
  });
});

describe("handleBenchReplay — validation and lookup", () => {
  it("errors on a missing public_id argument", async () => {
    await handleBenchReplay(undefined, {});
    expect(stderr).toContain("Usage:");
    expect(process.exitCode).toBe(1);
    expect(mockGetBenchResultByPublicId).not.toHaveBeenCalled();
  });

  it("errors on a non-numeric public_id argument", async () => {
    await handleBenchReplay("not-a-number", {});
    expect(stderr).toContain("Usage:");
    expect(process.exitCode).toBe(1);
  });

  it("accepts a '#'-prefixed public_id", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(null);
    await handleBenchReplay("#42", {});
    expect(mockGetBenchResultByPublicId).toHaveBeenCalledWith(42);
  });

  it("errors when no result matches the public_id", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(null);
    await handleBenchReplay("999999", {});
    expect(stderr).toContain("No bench result found with public_id #999999");
    expect(process.exitCode).toBe(1);
  });
});

describe("handleBenchReplay — display", () => {
  it("shows the task, reward/resolved/status, the parent run, and the reproducing command", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(resultRow());
    mockGetBenchRunByPublicId.mockResolvedValue(runRow());
    await handleBenchReplay("2984", {});
    expect(stdout).toContain("#2984");
    expect(stdout).toContain("django__django-11099");
    expect(stdout).toContain("reward: 1");
    expect(stdout).toContain("resolved: yes");
    expect(stdout).toContain("tokens: 507.0k"); // tokens_total surfaced in the replay view
    expect(stdout).toContain("cost: $4.20");
    expect(stdout).toContain("run: #3");
    expect(stdout).toContain("abc1234");
    expect(stdout).toContain("Reproducing command:");
    expect(stdout).toContain("Pass --run to execute it now.");
    expect(mockBuildReplayEnv).toHaveBeenCalledWith({ effort: "xhigh" });
  });

  it("still renders when the parent run can't be found", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(resultRow());
    mockGetBenchRunByPublicId.mockResolvedValue(null);
    await handleBenchReplay("2984", {});
    expect(stdout).toContain("run: #3");
    expect(stdout).not.toContain("undefined");
  });

  it("falls back to an empty config object when the config column is malformed JSON", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(
      resultRow({ config: "{ not valid json" }),
    );
    mockGetBenchRunByPublicId.mockResolvedValue(null);
    await expect(handleBenchReplay("2984", {})).resolves.not.toThrow();
    expect(mockBuildReplayEnv).toHaveBeenCalledWith({});
  });

  it("emits JSON with --json instead of the human-readable view", async () => {
    const row = resultRow();
    mockGetBenchResultByPublicId.mockResolvedValue(row);
    await handleBenchReplay("2984", { json: true });
    const parsed = JSON.parse(stdout) as {
      result: BenchmarkRunResultRow;
      env: unknown;
      script: string;
    };
    expect(parsed.result).toEqual(row);
    expect(parsed.script).toBe("bench/swe-bench/run.sh");
    // --json never needs the parent-run lookup (it's display-only context).
    expect(mockGetBenchRunByPublicId).not.toHaveBeenCalled();
  });
});

describe("handleBenchReplay — --run", () => {
  it("errors and exits 1 when the run.sh script can't be found above cwd", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(resultRow());
    mockGetBenchRunByPublicId.mockResolvedValue(null);
    mockExistsSync.mockReturnValue(false);
    await handleBenchReplay("2984", { run: true });
    expect(stderr).toContain("Could not find bench/swe-bench/run.sh");
    expect(process.exitCode).toBe(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns the script with inherited stdio and the reconstructed env, resolving the exit code", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(resultRow());
    mockGetBenchRunByPublicId.mockResolvedValue(null);
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith("bench/swe-bench/run.sh"),
    );

    const fakeChild = new EventEmitter();
    mockSpawn.mockReturnValue(fakeChild);

    const donePromise = handleBenchReplay("2984", { run: true });
    // Let the handler reach the spawn call before firing the exit event.
    await new Promise((r) => setTimeout(r, 0));
    fakeChild.emit("close", 0, null);
    await donePromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [scriptArg, argsArg, spawnOpts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; stdio: string },
    ];
    expect(scriptArg).toMatch(/bench\/swe-bench\/run\.sh$/);
    expect(argsArg).toEqual([]);
    expect(spawnOpts.stdio).toBe("inherit");
    expect(spawnOpts.env.OXAGEN_EFFORT).toBe("xhigh");
    expect(process.exitCode).toBe(0);
  });

  it("reports a non-zero exit code from the replayed run", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(resultRow());
    mockGetBenchRunByPublicId.mockResolvedValue(null);
    mockExistsSync.mockReturnValue(true);
    const fakeChild = new EventEmitter();
    mockSpawn.mockReturnValue(fakeChild);

    const donePromise = handleBenchReplay("2984", { run: true });
    await new Promise((r) => setTimeout(r, 0));
    fakeChild.emit("close", 3, null);
    await donePromise;

    expect(process.exitCode).toBe(3);
  });

  it("maps a signalled exit (code null) to 143", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(resultRow());
    mockGetBenchRunByPublicId.mockResolvedValue(null);
    mockExistsSync.mockReturnValue(true);
    const fakeChild = new EventEmitter();
    mockSpawn.mockReturnValue(fakeChild);

    const donePromise = handleBenchReplay("2984", { run: true });
    await new Promise((r) => setTimeout(r, 0));
    fakeChild.emit("close", null, "SIGTERM");
    await donePromise;

    expect(process.exitCode).toBe(143);
  });

  it("maps a spawn error (e.g. not executable) to exit 127", async () => {
    mockGetBenchResultByPublicId.mockResolvedValue(resultRow());
    mockGetBenchRunByPublicId.mockResolvedValue(null);
    mockExistsSync.mockReturnValue(true);
    const fakeChild = new EventEmitter();
    mockSpawn.mockReturnValue(fakeChild);

    const donePromise = handleBenchReplay("2984", { run: true });
    await new Promise((r) => setTimeout(r, 0));
    fakeChild.emit("error", new Error("EACCES"));
    await donePromise;

    expect(process.exitCode).toBe(127);
  });
});
