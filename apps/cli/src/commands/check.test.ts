/**
 * `oxagen check` on S0's fixture steering repo. The tests commit the fixture
 * to a git repository, clone it, apply an invalid case's changes to the
 * clone, and run the command there. The command's findings must equal what
 * runChecksWithServers reports for the same trees, and each case's finding must land
 * where its case.json says.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bundleSchema } from "@oxagen/oxagen/steering-repo";
import {
  FIXTURE_ROOT,
  fixtureContext,
  fixtureRepo,
  invalidCases,
  organizationFixtureRepo,
  type InvalidCase,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  formatHuman,
  type CheckReport,
  type Finding,
  type SteeringTree,
} from "@oxagen/steering-check";
import { runChecksWithServers } from "@oxagen/steering-check/servers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ApiError } from "../lib/api.js";
import type { CommandWriter } from "../lib/capture-writer.js";
import { buildProgram } from "../program.js";
import {
  check,
  findSteeringRoot,
  readBase,
  readHead,
  type CheckDeps,
  type CheckOptions,
  type PublishedInputs,
} from "./check.js";

// Each test clones a repository and runs every check, so it can take longer
// than vitest's five-second default on a busy runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The default fetcher's one call to the API. Every other test passes its own
// fetcher, so only the default-fetcher tests reach this.
const api = vi.hoisted(() => ({ apiGetOrThrow: vi.fn() }));
vi.mock("../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api.js")>()),
  apiGetOrThrow: api.apiGetOrThrow,
}));

// ── git ──────────────────────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(dir: string, message: string): void {
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** Write each file of `tree` under `dir`. */
function writeTree(dir: string, tree: SteeringTree): void {
  for (const [path, text] of tree) {
    const file = join(dir, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** A new repository at `dir` on branch main, with `tree` as its one commit. */
function commitTree(dir: string, tree: SteeringTree): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeTree(dir, tree);
  git(dir, "add", "-A");
  commit(dir, "base");
  return dir;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

/** The compile rules only a Cedar evaluator can find. `oxagen check` passes none. */
const CEDAR_RULES = new Set([
  "policy-parses",
  "policy-validates",
  "policy-test-passes",
]);

/**
 * Lines where a case.json points somewhere other than its file, as
 * @oxagen/steering-check's cases test reads them. The typed-stamp case names
 * line 5, its description. The id it expects is on line 14.
 */
const LINE_ERRATA: Readonly<Record<string, number>> = {
  "hash/typed-stamp": 14,
};

const NOT_A_STEERING_REPO =
  "This directory is not in a steering repo. Run oxagen check inside a clone that holds workspace.toml, or AGENTS.md and steering/ for an organization repo.";

const BAD_INDEX =
  "Oxagen could not fetch the published index. The index Oxagen returned does not have the records and context the checks read.";

/** The 403 the API answers a key for another workspace with, as apiGetOrThrow throws it. */
function scopeRefusal(): ApiError {
  const body = JSON.stringify({
    error: {
      code: "forbidden",
      reason: "key_scope_mismatch",
      message:
        "This API key belongs to workspace a-intel/other, and the request names a-intel/core-platform. Use a key for a-intel/core-platform, or request a-intel/other.",
    },
    requestId: "req_1",
  });
  return new ApiError(`Error 403 from context/steering/index: ${body}`, 403);
}

let work: string;
let origin: string;
let made = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "oxagen-check-"));
  origin = commitTree(join(work, "origin"), fixtureRepo());
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

/** A new folder under the test's temp folder. */
function fresh(name: string): string {
  made += 1;
  const dir = join(work, `${name}-${made}`);
  mkdirSync(dir);
  return dir;
}

/** A clone of the committed fixture repo. Its origin/HEAD names main. */
function clone(): string {
  made += 1;
  const dir = join(work, `clone-${made}`);
  git(work, "clone", "-q", origin, dir);
  return dir;
}

/** A clone with an invalid case's changes in its working tree. */
function cloneWith(item: InvalidCase): string {
  const dir = clone();
  for (const path of item.removed) rmSync(join(dir, ...path.split("/")));
  for (const path of item.changed) {
    const text = item.files.get(path);
    if (text === undefined) throw new Error(`${item.id} changes ${path} and holds no text for it`);
    writeTree(dir, new Map([[path, text]]));
  }
  return dir;
}

function caseById(id: string): InvalidCase {
  const found = invalidCases().find((item) => item.id === id);
  if (found === undefined) throw new Error(`no fixture case ${id}`);
  return found;
}

/** The fixture's published index and outside context. */
function published(): PublishedInputs {
  const bundle = bundleSchema.parse(
    JSON.parse(readFileSync(join(FIXTURE_ROOT, "stored", "bundle.json"), "utf8")),
  );
  const { runtimes, members, teams, groups, credentials } = fixtureContext();
  return {
    index: { records: bundle.records },
    context: { runtimes, members, teams, groups, credentials },
  };
}

function sorted(tree: SteeringTree): Map<string, string> {
  return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** What the command's checks report for the trees, read the way it reads them. */
function direct(
  files: SteeringTree,
  base: SteeringTree | null,
  inputs: PublishedInputs = published(),
): Promise<CheckReport> {
  return runChecksWithServers({
    files: sorted(files),
    base: base === null ? null : sorted(base),
    index: inputs.index,
    context: inputs.context,
    health: null,
  });
}

function resultLine(report: CheckReport): string | undefined {
  return formatHuman(report).trimEnd().split("\n").at(-1);
}

// ── Running the command ──────────────────────────────────────────────────────

interface Run {
  out: string[];
  err: string[];
  code: typeof process.exitCode;
}

/** Run the command with exactly `deps`, so the defaults fill the rest. */
async function runRaw(
  cwd: string,
  paths: string[],
  opts: CheckOptions,
  deps: Partial<CheckDeps>,
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const writer: CommandWriter = {
    write: (line) => {
      out.push(line);
    },
    writeErr: (line) => {
      err.push(line);
    },
  };
  await check(paths, opts, writer, cwd, deps);
  return { out, err, code: process.exitCode };
}

/** Run the command with the fixture's index, no cache, and a fixed clock. */
function run(
  cwd: string,
  paths: string[] = [],
  opts: CheckOptions = {},
  deps: Partial<CheckDeps> = {},
): Promise<Run> {
  return runRaw(cwd, paths, opts, {
    fetchPublished: () => Promise.resolve(published()),
    cacheDir: null,
    now: () => NOW,
    ...deps,
  });
}

/** The findings a `--json` run printed. */
function findings(result: Run): Finding[] {
  return result.out.map((line) => JSON.parse(line) as Finding);
}

type Place = InvalidCase["expect"][number];

function at(item: InvalidCase, place: Place, finding: Finding): boolean {
  const line = LINE_ERRATA[item.id] ?? place.line;
  return (
    finding.check === item.check &&
    finding.rule === item.rule &&
    finding.severity === item.severity &&
    finding.path === place.path &&
    (line === undefined || finding.line === line) &&
    (place.field === undefined || finding.field === place.field)
  );
}

const COMPARED = /^Compared with origin\/HEAD at [0-9a-f]{7}\.$/;

// ── The fixture cases ────────────────────────────────────────────────────────

describe("oxagen check on each invalid fixture case", () => {
  const cases = invalidCases();

  it("reads every case S0 wrote", () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  it.each(cases.map((item): [string, InvalidCase] => [item.id, item]))(
    "%s",
    async (_id, item) => {
      const result = await run(cloneWith(item), [], { json: true });
      const expected = await direct(item.files, fixtureRepo());
      const printed = findings(result);

      expect(printed).toEqual(expected.findings);
      expect(result.code).toBe(expected.passed ? undefined : 1);
      expect(result.err[0]).toMatch(COMPARED);
      expect(result.err.at(-1)).toBe(resultLine(expected));

      // A laptop reads no host settings, so the settings check is skipped.
      if (item.check === "settings") {
        expect(printed).toEqual([]);
        return;
      }
      // No Cedar evaluator runs on a laptop, so these rules find nothing.
      if (CEDAR_RULES.has(item.rule)) {
        expect(printed.filter((finding) => finding.rule === item.rule)).toEqual([]);
        return;
      }
      for (const place of item.expect) {
        const hit = printed.some((finding) => at(item, place, finding));
        expect(hit, `${JSON.stringify(place)} in ${JSON.stringify(printed, null, 2)}`).toBe(true);
      }
      if (item.severity === "error") expect(result.code).toBe(1);
    },
    60_000,
  );
});

describe("the report", () => {
  it("prints what formatHuman renders for a clone with no changes", async () => {
    const result = await run(clone());
    const expected = await direct(fixtureRepo(), fixtureRepo());

    expect(result.out).toEqual([formatHuman(expected).trimEnd()]);
    expect(result.err).toEqual([expect.stringMatching(COMPARED)]);
    expect(result.code).toBeUndefined();
    const [report = ""] = result.out;
    expect(report).toMatch(/^SKIP {2}settings +Skipped: /m);
    expect(report).toContain(
      "Oxagen did not evaluate the Cedar policies, because no Cedar evaluator was passed in.",
    );
    expect(report).toMatch(/The steering PR passes, with 0 errors and 0 warnings\.$/);
  });

  it("runs on the index and context the default fetcher reads", async () => {
    api.apiGetOrThrow.mockReset();
    api.apiGetOrThrow.mockResolvedValue(published());

    const result = await runRaw(clone(), [], {}, { cacheDir: null });
    const expected = await direct(fixtureRepo(), fixtureRepo());

    expect(api.apiGetOrThrow).toHaveBeenCalledTimes(1);
    expect(api.apiGetOrThrow).toHaveBeenCalledWith(
      "context/steering/index",
      undefined,
      { org: "a-intel", ws: "core-platform" },
    );
    expect(result.out).toEqual([formatHuman(expected).trimEnd()]);
    expect(result.code).toBeUndefined();
  });

  it("prints each finding and exits 1 when a finding is an error", async () => {
    const item = caseById("owned/agents-md-edited");
    const result = await run(cloneWith(item));
    const expected = await direct(item.files, fixtureRepo());

    expect(result.out).toEqual([formatHuman(expected).trimEnd()]);
    expect(result.out[0]).toContain(`  error owned/${item.rule} at AGENTS.md`);
    expect(result.out[0]).toMatch(/Fix each error, then run the checks again\.$/);
    expect(result.code).toBe(1);
  });

  it("passes a steering PR that changes one valid record", async () => {
    const dir = clone();
    const file = join(dir, "steering", "brand", "a-intel.brand.plain-words.md");
    const before = readFileSync(file, "utf8");
    const after = before
      .replace("with numbers over", "with figures over")
      .split("\n")
      .filter((line) => !line.startsWith("id: ") && !line.startsWith("hash: "))
      .join("\n");
    expect(after).not.toBe(before);
    writeFileSync(file, after);

    const result = await run(dir, [], { json: true });

    expect(result.out).toEqual([]);
    expect(result.err.at(-1)).toBe("The steering PR passes, with 0 errors and 0 warnings.");
    expect(result.code).toBeUndefined();
  });

  it("reads committed changes as well as the working tree", async () => {
    const item = caseById("owned/agents-md-edited");
    const dir = cloneWith(item);
    git(dir, "checkout", "-q", "-b", "edit");
    git(dir, "add", "-A");
    commit(dir, "edit");

    const result = await run(dir, [], { json: true });

    expect(findings(result)).toEqual((await direct(item.files, fixtureRepo())).findings);
    expect(result.code).toBe(1);
  });

  it("runs from a folder inside the steering repo", async () => {
    const item = caseById("owned/agents-md-edited");
    const dir = cloneWith(item);

    const result = await run(join(dir, "steering", "billing"), [], { json: true });

    expect(findings(result)).toEqual((await direct(item.files, fixtureRepo())).findings);
  });

  it("finds an organization repo by AGENTS.md and steering/", async () => {
    const tree = organizationFixtureRepo();
    const dir = commitTree(fresh("org"), tree);

    const result = await run(join(dir, "steering"), [], { json: true, base: "main" });

    expect(findings(result)).toEqual((await direct(tree, tree)).findings);
    expect(result.err[0]).toMatch(/^Compared with main at [0-9a-f]{7}\.$/);
  });
});

// ── The base ─────────────────────────────────────────────────────────────────

describe("the base", () => {
  it("compares with the ref --base names", async () => {
    const dir = clone();
    const sha = git(dir, "rev-parse", "main");

    const result = await run(dir, [], { base: "main" });

    expect(result.err[0]).toBe(`Compared with main at ${sha.slice(0, 7)}.`);
  });

  it("compares with origin/main when origin/HEAD is not set", async () => {
    const dir = clone();
    git(dir, "remote", "set-head", "origin", "--delete");

    const result = await run(dir);

    expect(result.err[0]).toMatch(/^Compared with origin\/main at [0-9a-f]{7}\.$/);
  });

  it("reads the working tree whole when no production branch resolves", async () => {
    const dir = clone();
    git(dir, "remote", "remove", "origin");

    const result = await run(dir, [], { json: true });
    const expected = await direct(fixtureRepo(), null);

    expect(findings(result)).toEqual(expected.findings);
    expect(result.err[0]).toBe(
      "No production branch to compare with. origin/HEAD and origin/main do not resolve in this clone, so the checks read the working tree whole. Pass --base <ref> to compare with a branch.",
    );
    expect(result.code).toBe(expected.passed ? undefined : 1);
  });

  it.each(["nope", "-x"])("exits 2 when --base %s names no commit", async (ref) => {
    const result = await run(clone(), [], { base: ref });

    expect(result.err).toEqual([`✗ --base ${ref} does not name a commit in this clone.`]);
    expect(result.out).toEqual([]);
    expect(result.code).toBe(2);
  });
});

// ── Paths ────────────────────────────────────────────────────────────────────

describe("paths", () => {
  const item = caseById("compile/lock-matches");
  let full: CheckReport;
  beforeAll(async () => {
    full = await direct(item.files, fixtureRepo());
  });
  const inSteering = (finding: Finding) =>
    finding.path === "" || finding.path.startsWith("steering/");

  it("keeps the findings under the paths and says how many it left out", async () => {
    const kept = full.findings.filter(inSteering);
    const hidden = full.findings.length - kept.length;
    expect(hidden).toBeGreaterThan(0);

    const result = await run(cloneWith(item), ["steering"], { json: true });

    expect(findings(result)).toEqual(kept);
    expect(result.err).toContain(
      `The report shows the findings in steering. It leaves out ${hidden} ${hidden === 1 ? "finding" : "findings"} in other files.`,
    );
    expect(result.code).toBe(kept.some((finding) => finding.severity === "error") ? 1 : undefined);
  });

  it("counts a check again when it loses findings, and keeps its note", async () => {
    const compile = full.results.find((entry) => entry.check === "compile");
    expect(compile?.status).toBe("failed");
    expect(compile?.findings.some(inSteering)).toBe(false);
    expect(compile?.summary).toMatch(/ Oxagen did not evaluate the Cedar policies/);

    const result = await run(cloneWith(item), ["steering"]);

    expect(result.out[0]).toMatch(
      /^PASS {2}compile +No findings\. Oxagen did not evaluate the Cedar policies, because no Cedar evaluator was passed in\.$/m,
    );
  });

  it("keeps the finding in a file it names", async () => {
    const result = await run(cloneWith(item), ["tools/servers/billing/tools.toml"], { json: true });

    expect(findings(result).some((finding) => finding.rule === "lock-matches")).toBe(true);
    expect(result.code).toBe(1);
  });

  it("reads a path from the current folder", async () => {
    const dir = cloneWith(item);

    const result = await run(join(dir, "tools", "servers"), ["billing"], { json: true });

    expect(findings(result).some((finding) => finding.rule === "lock-matches")).toBe(true);
  });

  it("shows every finding for the repo's root", async () => {
    const result = await run(cloneWith(item), ["."], { json: true });

    expect(findings(result)).toEqual(full.findings);
    expect(result.err.some((line) => line.startsWith("The report shows"))).toBe(false);
  });

  it("takes a file the steering PR removes", async () => {
    const removal = caseById("references/skill-file-exists");
    const [removed = ""] = removal.removed;

    expect(removed).toMatch(/^steering\//);

    const result = await run(cloneWith(removal), [removed], { json: true });

    expect(result.err[0]).toMatch(COMPARED);
    expect(result.code).not.toBe(2);
  });

  it("exits 2 for a path that holds no file the check reads", async () => {
    const result = await run(clone(), ["nope"]);

    expect(result.err).toEqual(["✗ nope holds no file the steering PR check reads."]);
    expect(result.code).toBe(2);
  });

  it.each(["..", "../origin"])("exits 2 for %s, outside the steering repo", async (path) => {
    const dir = clone();

    const result = await run(dir, [path]);

    expect(result.err).toEqual([`✗ ${path} is outside the steering repo at ${resolve(dir)}.`]);
    expect(result.code).toBe(2);
  });
});

// ── Setup failures ───────────────────────────────────────────────────────────

describe("exit 2", () => {
  it("outside a steering repo", async () => {
    const result = await run(fresh("empty"), [], { json: true });

    expect(result.err.map((line) => JSON.parse(line) as unknown)).toEqual([
      { type: "error", code: "not_a_steering_repo", message: NOT_A_STEERING_REPO },
    ]);
    expect(result.code).toBe(2);
  });

  it("in a steering repo that is not a git clone", async () => {
    const dir = fresh("loose");
    writeFileSync(join(dir, "workspace.toml"), 'schema = "workspace/v1"\n');

    const result = await run(dir);

    expect(result.err).toEqual([
      `✗ ${dir} is not in a git clone. oxagen check compares the working tree with the production branch, and reads both through git.`,
    ]);
    expect(result.code).toBe(2);
  });

  it("when git cannot read the index", async () => {
    const dir = clone();
    writeFileSync(join(dir, ".git", "index"), "not an index");

    const result = await run(dir);

    expect(result.err).toEqual([`✗ Oxagen could not list the files in ${dir} with git.`]);
    expect(result.code).toBe(2);
  });

  it("when the base is missing a blob", async () => {
    const dir = commitTree(fresh("broken"), fixtureRepo());
    const oid = git(dir, "rev-parse", "main:AGENTS.md");
    rmSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)), { force: true });

    const result = await run(dir, [], { base: "main" });

    expect(result.err).toEqual(["✗ Oxagen could not read main with git."]);
    expect(result.code).toBe(2);
  });

  it("when the default fetcher's API call fails", async () => {
    api.apiGetOrThrow.mockReset();
    api.apiGetOrThrow.mockRejectedValue(new ApiError("The API answered 503.", 503));

    const result = await runRaw(clone(), [], {}, { cacheDir: null });

    expect(result.err).toEqual([
      "✗ Oxagen could not fetch the published index. The API answered 503.",
    ]);
    expect(result.out).toEqual([]);
    expect(result.code).toBe(2);
  });

  it("when the login is for another workspace than workspace.toml names", async () => {
    api.apiGetOrThrow.mockReset();
    api.apiGetOrThrow.mockRejectedValue(scopeRefusal());

    const result = await runRaw(clone(), [], {}, { cacheDir: null });

    expect(result.err).toEqual([
      "✗ Oxagen could not fetch the published index. Your login is for another workspace than a-intel/core-platform, the one workspace.toml names. Run oxagen login --org a-intel --workspace core-platform, or fix workspace.toml to name the workspace you logged in to.",
    ]);
    expect(result.out).toEqual([]);
    expect(result.code).toBe(2);
  });

  it("with the scope_mismatch code in --json", async () => {
    api.apiGetOrThrow.mockReset();
    api.apiGetOrThrow.mockRejectedValue(scopeRefusal());

    const result = await runRaw(clone(), [], { json: true }, { cacheDir: null });

    expect(result.err.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({ type: "error", code: "scope_mismatch" }),
    ]);
    expect(result.code).toBe(2);
  });

  it("when the login is for another workspace than the CLI has selected", async () => {
    vi.stubEnv("OXAGEN_ORG_ID", "a-intel");
    vi.stubEnv("OXAGEN_WORKSPACE_ID", "core-platform");
    api.apiGetOrThrow.mockReset();
    api.apiGetOrThrow.mockRejectedValue(scopeRefusal());
    const dir = commitTree(fresh("org"), organizationFixtureRepo());

    const result = await runRaw(dir, [], {}, { cacheDir: null });

    expect(api.apiGetOrThrow).toHaveBeenCalledWith(
      "context/steering/index",
      undefined,
      undefined,
    );
    expect(result.err).toEqual([
      "✗ Oxagen could not fetch the published index. Your login is for another workspace than a-intel/core-platform, the one the CLI has selected. Run oxagen login --org a-intel --workspace core-platform.",
    ]);
    expect(result.code).toBe(2);
  });

  it.each<[string, Error]>([
    ["an error that is not the API's", new Error("The socket closed.")],
    ["a body that is not JSON", new ApiError("Error 403 from context/steering/index: {forbidden}", 403)],
    ["a body with no error object", new ApiError('Error 403 from context/steering/index: {"error":"forbidden"}', 403)],
    [
      "another reason",
      new ApiError(
        'Error 403 from context/steering/index: {"error":{"code":"forbidden","reason":"not_member","message":"No."}}',
        403,
      ),
    ],
  ])("as index_unavailable for %s", async (_name, error) => {
    api.apiGetOrThrow.mockReset();
    api.apiGetOrThrow.mockRejectedValue(error);

    const result = await runRaw(clone(), [], { json: true }, { cacheDir: null });

    expect(result.err.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        type: "error",
        code: "index_unavailable",
        message: `Oxagen could not fetch the published index. ${error.message}`,
      },
    ]);
    expect(result.code).toBe(2);
  });

  it("when the fetch fails", async () => {
    const result = await run(clone(), [], {}, {
      fetchPublished: () => Promise.reject(new Error("The API answered 503.")),
    });

    expect(result.err).toEqual([
      "✗ Oxagen could not fetch the published index. The API answered 503.",
    ]);
    expect(result.code).toBe(2);
  });

  const good = published();
  const record = good.index?.records[0];
  it.each<[string, unknown]>([
    ["nothing", null],
    ["a list", []],
    ["an index that is text", { index: "x", context: good.context }],
    ["records that are not a list", { index: { records: {} }, context: good.context }],
    ["a record that is null", { index: { records: [null] }, context: good.context }],
    ["a record with no lineage", { index: { records: [{ ...record, lineage: undefined }] }, context: good.context }],
    ["a record whose effect is a number", { index: { records: [{ ...record, effect: 3 }] }, context: good.context }],
    ["a record whose statement is a list", { index: { records: [{ ...record, statement: ["x"] }] }, context: good.context }],
    ["no context", { index: null }],
    ["a context list that holds a number", { index: null, context: { ...good.context, teams: [7] } }],
  ])("when the fetched index holds %s", async (_name, value) => {
    const result = await run(clone(), [], {}, {
      fetchPublished: () => Promise.resolve(value as PublishedInputs),
    });

    expect(result.err).toEqual([`✗ ${BAD_INDEX}`]);
    expect(result.code).toBe(2);
  });
});

// ── The cache ────────────────────────────────────────────────────────────────

describe("the published index cache", () => {
  // The cache key reads the API address and the token. Stub both, so no
  // test reads the config file of the machine it runs on.
  beforeEach(() => {
    vi.stubEnv("OXAGEN_API_URL", "https://api.example.invalid");
    vi.stubEnv("OXAGEN_API_TOKEN", "oxk_first");
  });

  function fetcher(inputs: PublishedInputs = published()) {
    return vi.fn<CheckDeps["fetchPublished"]>(() => Promise.resolve(inputs));
  }

  /** The one file in `cacheDir`. */
  function cacheFileIn(cacheDir: string): string {
    const [name, ...rest] = readdirSync(cacheDir);
    expect(rest).toEqual([]);
    if (name === undefined) throw new Error(`${cacheDir} holds no cache file`);
    return join(cacheDir, name);
  }

  it("fetches once, then reads the cache for ten minutes", async () => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    const first = await run(dir, [], { json: true }, { fetchPublished, cacheDir, now: () => NOW });
    const second = await run(dir, [], { json: true }, {
      fetchPublished,
      cacheDir,
      now: () => NOW + CACHE_MAX_AGE_MS - 1,
    });

    expect(fetchPublished).toHaveBeenCalledTimes(1);
    expect(fetchPublished).toHaveBeenCalledWith(resolve(dir));
    expect(second.out).toEqual(first.out);
    expect(second.err).toEqual(first.err);
    const entry = JSON.parse(readFileSync(cacheFileIn(cacheDir), "utf8")) as { fetched_at: string };
    expect(entry.fetched_at).toBe(new Date(NOW).toISOString());
  });

  it.each<[string, number]>([
    ["ten minutes old", CACHE_MAX_AGE_MS],
    ["from the future", -1],
  ])("fetches again when the cache is %s", async (_name, age) => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    await run(dir, [], {}, { fetchPublished, cacheDir, now: () => NOW });
    await run(dir, [], {}, { fetchPublished, cacheDir, now: () => NOW + age });

    expect(fetchPublished).toHaveBeenCalledTimes(2);
  });

  it.each<[string, string]>([
    ["text that is not JSON", "not json"],
    ["a list", "[]"],
    ["no fetch time", "{}"],
    ["no context", JSON.stringify({ fetched_at: new Date(NOW).toISOString(), index: null })],
  ])("fetches again when the cache holds %s", async (_name, text) => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    await run(dir, [], {}, { fetchPublished, cacheDir });
    writeFileSync(cacheFileIn(cacheDir), text);
    await run(dir, [], {}, { fetchPublished, cacheDir });

    expect(fetchPublished).toHaveBeenCalledTimes(2);
  });

  it("reads the cache again with the same API, workspace, and login", async () => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    await run(dir, [], {}, { fetchPublished, cacheDir });
    await run(dir, [], {}, { fetchPublished, cacheDir });

    expect(fetchPublished).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (dir: string) => void]>([
    [
      "another login",
      () => {
        vi.stubEnv("OXAGEN_API_TOKEN", "oxk_second");
      },
    ],
    [
      "another API",
      () => {
        vi.stubEnv("OXAGEN_API_URL", "https://api.other.invalid");
      },
    ],
    [
      "another workspace in workspace.toml",
      (dir) => {
        const file = join(dir, "workspace.toml");
        const text = readFileSync(file, "utf8");
        expect(text).toContain('workspace = "core-platform"');
        writeFileSync(file, text.replace('workspace = "core-platform"', 'workspace = "billing"'));
      },
    ],
    [
      "another organization in workspace.toml",
      (dir) => {
        const file = join(dir, "workspace.toml");
        const text = readFileSync(file, "utf8");
        expect(text).toContain('organization = "a-intel"');
        writeFileSync(file, text.replace('organization = "a-intel"', 'organization = "b-intel"'));
      },
    ],
  ])("fetches again under %s", async (_name, change) => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    await run(dir, [], {}, { fetchPublished, cacheDir });
    change(dir);
    await run(dir, [], {}, { fetchPublished, cacheDir });

    expect(fetchPublished).toHaveBeenCalledTimes(2);
    expect(readdirSync(cacheDir)).toHaveLength(2);
  });

  it("fetches again when the CLI selects another workspace for an organization repo", async () => {
    vi.stubEnv("OXAGEN_ORG_ID", "a-intel");
    vi.stubEnv("OXAGEN_WORKSPACE_ID", "core-platform");
    const dir = commitTree(fresh("org"), organizationFixtureRepo());
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    await run(dir, [], {}, { fetchPublished, cacheDir });
    await run(dir, [], {}, { fetchPublished, cacheDir });
    vi.stubEnv("OXAGEN_WORKSPACE_ID", "billing");
    await run(dir, [], {}, { fetchPublished, cacheDir });

    expect(fetchPublished).toHaveBeenCalledTimes(2);
  });

  it("keeps the token out of the cache", async () => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);

    await run(dir, [], {}, { fetchPublished: fetcher(), cacheDir });

    const [name] = readdirSync(cacheDir);
    expect(name).not.toContain("oxk_first");
    expect(readFileSync(join(cacheDir, name ?? ""), "utf8")).not.toContain("oxk_first");
  });

  it("fetches again with --refresh", async () => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    await run(dir, [], {}, { fetchPublished, cacheDir });
    await run(dir, [], { refresh: true }, { fetchPublished, cacheDir });

    expect(fetchPublished).toHaveBeenCalledTimes(2);
  });

  it("uses the clock when none is passed", async () => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const fetchPublished = fetcher();

    await runRaw(dir, [], {}, { fetchPublished, cacheDir });
    await runRaw(dir, [], {}, { fetchPublished, cacheDir });

    expect(fetchPublished).toHaveBeenCalledTimes(1);
  });

  it("passes a null index through the cache", async () => {
    const dir = clone();
    const cacheDir = join(work, `cache-${(made += 1)}`);
    const inputs: PublishedInputs = { ...published(), index: null };
    const fetchPublished = fetcher(inputs);

    const first = await run(dir, [], { json: true }, { fetchPublished, cacheDir });
    const second = await run(dir, [], { json: true }, { fetchPublished, cacheDir });

    expect(fetchPublished).toHaveBeenCalledTimes(1);
    expect(findings(second)).toEqual((await direct(fixtureRepo(), fixtureRepo(), inputs)).findings);
    expect(second.out).toEqual(first.out);
  });

  it("warns and runs the checks when it cannot write the cache", async () => {
    const dir = clone();
    const blocker = join(fresh("blocked"), "file");
    writeFileSync(blocker, "");
    const cacheDir = join(blocker, "cache");

    const result = await run(dir, [], { json: true }, { fetchPublished: fetcher(), cacheDir });

    expect(result.err).toContainEqual(
      expect.stringMatching(
        /^Oxagen could not cache the published index at .+: .+\. The next run fetches it again\.$/,
      ),
    );
    expect(result.err.at(-1)).toBe("The steering PR passes, with 0 errors and 0 warnings.");
    expect(result.code).toBeUndefined();
  });
});

// ── Reading the trees ────────────────────────────────────────────────────────

describe("readHead", () => {
  it("reads tracked and untracked files, and leaves out ignored, deleted, and outside files", () => {
    const dir = clone();
    writeFileSync(join(dir, ".gitignore"), "steering/ignored.md\n");
    writeFileSync(join(dir, "steering", "ignored.md"), "ignored\n");
    writeFileSync(join(dir, "steering", "new.md"), "new\n");
    writeFileSync(join(dir, "notes.txt"), "outside\n");
    rmSync(join(dir, "README.md"));

    const head = readHead(dir);

    expect(head?.get("steering/new.md")).toBe("new\n");
    expect(head?.has("steering/ignored.md")).toBe(false);
    expect(head?.has("notes.txt")).toBe(false);
    expect(head?.has(".gitignore")).toBe(false);
    expect(head?.has("README.md")).toBe(false);
    expect(head?.get("AGENTS.md")).toBe(fixtureRepo().get("AGENTS.md"));
    expect([...(head?.keys() ?? [])]).toEqual([...(head?.keys() ?? [])].sort());
  });

  it("reads a symlink as its target, as git stores it", () => {
    const dir = clone();
    symlinkSync("../README.md", join(dir, "steering", "link.md"));

    expect(readHead(dir)?.get("steering/link.md")).toBe("../README.md");
  });

  it("skips a submodule", () => {
    const dir = clone();
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${sha},steering/sub`);
    mkdirSync(join(dir, "steering", "sub"));
    commit(dir, "submodule");

    expect(readHead(dir)?.has("steering/sub")).toBe(false);
    expect(readBase(dir, git(dir, "rev-parse", "HEAD"))?.has("steering/sub")).toBe(false);
  });

  it("is null outside a git clone", () => {
    expect(readHead(fresh("plain"))).toBeNull();
  });
});

describe("readBase", () => {
  it("reads each blob at the commit, in path order", () => {
    const dir = clone();

    const base = readBase(dir, git(dir, "rev-parse", "main"));

    expect(base).toEqual(sorted(fixtureRepo()));
    expect([...(base?.keys() ?? [])]).toEqual([...sorted(fixtureRepo()).keys()]);
  });

  it("is empty for a commit with no file the check reads", () => {
    const dir = commitTree(fresh("other"), new Map([["notes.txt", "hi\n"]]));

    expect(readBase(dir, git(dir, "rev-parse", "main"))).toEqual(new Map());
    expect(readHead(dir)).toEqual(new Map());
  });

  it("is null for a commit git does not hold", () => {
    expect(readBase(clone(), "0".repeat(40))).toBeNull();
  });
});

describe("findSteeringRoot", () => {
  it("walks up to workspace.toml", () => {
    const dir = clone();

    expect(findSteeringRoot(join(dir, "steering", "billing"))).toBe(resolve(dir));
  });

  it("takes AGENTS.md with steering/ as an organization repo", () => {
    const dir = fresh("org-shape");
    writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
    mkdirSync(join(dir, "steering"));

    expect(findSteeringRoot(join(dir, "steering"))).toBe(resolve(dir));
  });

  it("is null for AGENTS.md alone, or a workspace.toml folder", () => {
    const dir = fresh("no-root");
    writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
    mkdirSync(join(dir, "workspace.toml"));

    expect(findSteeringRoot(dir)).toBeNull();
  });
});

// ── The command line ─────────────────────────────────────────────────────────

describe("oxagen check on the command line", () => {
  it("registers the paths argument and three options", () => {
    const command = buildProgram().commands.find((entry) => entry.name() === "check");

    expect(command?.description()).toMatch(/steering PR checks/);
    expect(command?.options.map((option) => option.long).sort()).toEqual([
      "--base",
      "--json",
      "--refresh",
    ]);
    expect(
      command?.registeredArguments.map((arg) => [arg.name(), arg.variadic, arg.required]),
    ).toEqual([["paths", true, false]]);
  });

  it("reads the current folder and writes to the process streams", async () => {
    const empty = fresh("cwd");
    vi.spyOn(process, "cwd").mockReturnValue(empty);
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    await buildProgram()
      .exitOverride()
      .parseAsync(["check", "--json", "--base", "main", "steering"], { from: "user" });

    expect(JSON.parse(stderr.trim())).toEqual({
      type: "error",
      code: "not_a_steering_repo",
      message: NOT_A_STEERING_REPO,
    });
    expect(process.exitCode).toBe(2);
  });

  it("runs with no arguments", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(fresh("bare"));
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    await check();

    expect(stderr).toBe(`✗ ${NOT_A_STEERING_REPO}\n`);
    expect(process.exitCode).toBe(2);
  });
});
