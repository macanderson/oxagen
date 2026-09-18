/**
 * The whole feature against real git.
 *
 * Every other test in this package stubs the runner, which proves the logic
 * and proves nothing about whether the git invocations are the right ones.
 * This one builds an actual origin, an actual clone, and an actual merge
 * onto the production branch, and asks the same questions a developer's
 * checkout would. It is the test that fails if a git flag is wrong, if
 * `:(exclude)` magic stops working, or if `restore --source` changes
 * behaviour.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSteeringFreshness, isSyncSafe } from "./check";
import { evaluateGate } from "./gate";
import { resolveSteeringPolicy, type SteeringPolicyFile } from "./policy";
import { syncSteering } from "./sync";

const run = promisify(execFile);

/** Run git in `cwd` with a fixed identity, so the test needs no global config. */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout.trim();
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

/** A record file in the shape `docs/specs/steering/README.md` describes. */
function recordToml(lineage: string, statement: string): string {
  return [
    'schema = "context-record/v0.1"',
    'set_id = "acme.platform"',
    "",
    "[[record]]",
    `lineage_id = "${lineage}"`,
    'kind = "rule"',
    `statement = "${statement}"`,
    'origin = "user"',
    'status = "active"',
    "",
  ].join("\n");
}

/**
 * `fetchIntervalSeconds: 0` on purpose. The throttle is real product
 * behaviour (a 300 second default keeps a network round trip off the front
 * of every prompt), and it would make this file lie: the first check writes
 * a stamp, and every later one would then compare against a remote ref that
 * predates the merge the test just made. The throttle gets its own test at
 * the bottom of the file instead.
 */
const policy = (file: SteeringPolicyFile = {}) =>
  resolveSteeringPolicy([
    { scope: "project", policy: { fetchIntervalSeconds: 0, ...file } },
  ]);

let tmp: string;
let origin: string;
let work: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oxagen-steering-"));
  origin = join(tmp, "origin.git");
  work = join(tmp, "work");

  // A bare origin with a `main` branch holding one record.
  const seed = join(tmp, "seed");
  await mkdir(seed, { recursive: true });
  await g(seed, "init", "--quiet", "--initial-branch=main");
  await write(seed, ".oxagen/workspace.json", '{"workspace":"acme"}\n');
  await write(
    seed,
    ".oxagen/rules/ctx.base.always.toml",
    recordToml("ctx.base.always", "Always read the run ledger first."),
  );
  await write(seed, "README.md", "# acme\n");
  await g(seed, "add", "-A");
  await g(seed, "commit", "--quiet", "-m", "seed");

  await g(tmp, "clone", "--bare", "--quiet", seed, origin);
  await g(tmp, "clone", "--quiet", origin, work);
  await g(work, "config", "user.name", "Test");
  await g(work, "config", "user.email", "test@example.invalid");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Merge a new record onto the production branch, as a Context PR does. */
async function mergeContextPr(
  lineage: string,
  statement: string,
): Promise<void> {
  const author = join(tmp, `author-${lineage}`);
  await g(tmp, "clone", "--quiet", origin, author);
  await g(author, "config", "user.name", "Test");
  await g(author, "config", "user.email", "test@example.invalid");
  await write(
    author,
    `.oxagen/rules/${lineage}.toml`,
    recordToml(lineage, statement),
  );
  await g(author, "add", "-A");
  await g(author, "commit", "--quiet", "-m", `context: publish ${lineage}`);
  await g(author, "push", "--quiet", "origin", "main");
}

// The exploit, run for real. `.oxagen/settings.json` is committed, so a
// hostile checkout controls `remote`. Before the guard, git read
// `--upload-pack=<command>` as an option to `fetch` and ran the command. The
// marker file is the proof: it must not exist after the check.
describe("a hostile remote name in committed settings", () => {
  it("never reaches git, so the command it smuggles never runs", async () => {
    const marker = join(tmp, "pwned");
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: resolveSteeringPolicy([
        {
          scope: "project",
          policy: {
            remote: `--upload-pack=touch ${marker} #`,
            branch: "main",
          },
        },
      ]),
    });
    expect(verdict.status).toBe("unknown");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});

describe("a checkout on the production branch", () => {
  it("is current, and resolves the default branch without being told", async () => {
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    expect(verdict.status).toBe("current");
    expect(verdict.branch).toBe("main");
    expect(verdict.missing).toEqual([]);
    expect(verdict.fingerprint.local).toBe(verdict.fingerprint.remote);
  });

  it("answers from a subdirectory the same way", async () => {
    const sub = join(work, ".oxagen", "rules");
    const verdict = await checkSteeringFreshness({
      cwd: sub,
      policy: policy(),
    });
    expect(verdict.status).toBe("current");
  });
});

describe("a feature branch while Context PRs keep merging", () => {
  beforeAll(async () => {
    await g(work, "checkout", "--quiet", "-b", "feature/widget");
    await write(work, "src.txt", "work in progress\n");
    await g(work, "add", "-A");
    await g(work, "commit", "--quiet", "-m", "wip");
    await mergeContextPr(
      "ctx.release.pin-schema",
      "Pin the schema before a release.",
    );
  });

  it("notices the merged record, and names it", async () => {
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    expect(verdict.status).toBe("behind");
    expect(verdict.missing).toEqual([
      { status: "added", path: ".oxagen/rules/ctx.release.pin-schema.toml" },
    ]);
    expect(verdict.behindByCommits).toBe(1);
    expect(isSyncSafe(verdict)).toBe(true);
  });

  // Work outside `.oxagen/` is none of this feature's business.
  it("ignores the branch's own code changes", async () => {
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    expect(verdict.local).toEqual([]);
    expect(verdict.dirty).toEqual([]);
  });

  it("warns without blocking by default", async () => {
    const decision = await evaluateGate({
      cwd: work,
      policy: policy(),
      readOnly: true,
    });
    expect(decision.action).toBe("warn");
    expect(decision.exitCode).toBe(0);
  });

  it("blocks once the policy says so", async () => {
    const decision = await evaluateGate({
      cwd: work,
      policy: policy({ blockStaleRuns: true }),
      readOnly: true,
    });
    expect(decision.action).toBe("block");
    expect(decision.exitCode).toBe(2);
  });

  it("syncs the record in, staged, and then reads as current", async () => {
    const before = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    const result = await syncSteering({ cwd: work, verdict: before });
    expect(result.applied).toBe(true);
    expect(result.updated).toEqual([
      ".oxagen/rules/ctx.release.pin-schema.toml",
    ]);

    const body = await readFile(
      join(work, ".oxagen/rules/ctx.release.pin-schema.toml"),
      "utf8",
    );
    expect(body).toContain("Pin the schema before a release.");
    // Staged, not committed: `git status` shows it, and nothing was
    // committed into the developer's branch behind their back.
    expect(await g(work, "diff", "--cached", "--name-only")).toBe(
      ".oxagen/rules/ctx.release.pin-schema.toml",
    );

    const after = await checkSteeringFreshness({ cwd: work, policy: policy() });
    expect(after.status).toBe("current");
    expect(after.dirty).toEqual([".oxagen/rules/ctx.release.pin-schema.toml"]);
  });
});

describe("a branch that is authoring its own record", () => {
  beforeAll(async () => {
    await g(
      work,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "chore(steering): sync",
    );
    await write(
      work,
      ".oxagen/rules/ctx.mine.draft.toml",
      recordToml("ctx.mine.draft", "A record this branch is writing."),
    );
    await g(work, "add", "-A");
    await g(work, "commit", "--quiet", "-m", "context: draft");
  });

  // The case a directory comparison gets wrong, proved against real git.
  it("is ahead, not behind, and is never blocked", async () => {
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    expect(verdict.status).toBe("ahead");
    // Only the record this branch is writing. The one it synced and
    // committed a moment ago is identical to the production branch's, so it
    // is not work a sync would destroy.
    expect(verdict.local).toEqual([
      { status: "added", path: ".oxagen/rules/ctx.mine.draft.toml" },
    ]);
    const decision = await evaluateGate({
      cwd: work,
      policy: policy({ blockStaleRuns: true }),
      readOnly: true,
    });
    expect(decision.action).toBe("allow");
  });

  it("is diverged once the production branch also moves", async () => {
    await mergeContextPr(
      "ctx.audit.seal",
      "Seal the run before you export it.",
    );
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    expect(verdict.status).toBe("diverged");
    expect(isSyncSafe(verdict)).toBe(false);
  });

  it("refuses to sync over the branch's own record", async () => {
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    const result = await syncSteering({ cwd: work, verdict });
    expect(result.applied).toBe(false);
    expect(result.refusal).toBe("diverged");
    // The authored record is still there.
    await expect(
      readFile(join(work, ".oxagen/rules/ctx.mine.draft.toml"), "utf8"),
    ).resolves.toContain("A record this branch is writing.");
  });

  it("auto-sync refuses too, and the gate still blocks", async () => {
    const decision = await evaluateGate({
      cwd: work,
      policy: policy({ autoSync: true, blockStaleRuns: true }),
    });
    expect(decision.sync?.applied).toBe(false);
    expect(decision.action).toBe("block");
  });
});

describe("uncommitted work under .oxagen", () => {
  let dirtyWork: string;

  beforeAll(async () => {
    dirtyWork = join(tmp, "dirty");
    await g(tmp, "clone", "--quiet", origin, dirtyWork);
    await g(dirtyWork, "config", "user.name", "Test");
    await g(dirtyWork, "config", "user.email", "test@example.invalid");
    await g(dirtyWork, "checkout", "--quiet", "-b", "feature/dirty");
    await write(
      dirtyWork,
      ".oxagen/rules/ctx.base.always.toml",
      recordToml("ctx.base.always", "Edited, not saved."),
    );
    await mergeContextPr("ctx.spend.ceiling", "Stop at the ceiling.");
  });

  it("reports the edit and refuses to overwrite it", async () => {
    const verdict = await checkSteeringFreshness({
      cwd: dirtyWork,
      policy: policy(),
    });
    expect(verdict.status).toBe("behind");
    expect(verdict.dirty).toEqual([".oxagen/rules/ctx.base.always.toml"]);
    const result = await syncSteering({ cwd: dirtyWork, verdict });
    expect(result.refusal).toBe("dirty");
    await expect(
      readFile(join(dirtyWork, ".oxagen/rules/ctx.base.always.toml"), "utf8"),
    ).resolves.toContain("Edited, not saved.");
  });

  // The personal settings file is excluded, so it can never make a checkout
  // look dirty and can never be synced away.
  it("ignores .oxagen/settings.local.json entirely", async () => {
    await write(dirtyWork, ".oxagen/settings.local.json", '{"steering":{}}\n');
    const verdict = await checkSteeringFreshness({
      cwd: dirtyWork,
      policy: policy(),
    });
    expect(verdict.dirty).not.toContain(".oxagen/settings.local.json");
  });
});

describe("a repository with no Oxagen remote to reach", () => {
  it("answers unknown, and never blocks", async () => {
    const lonely = join(tmp, "lonely");
    await mkdir(lonely, { recursive: true });
    await g(lonely, "init", "--quiet", "--initial-branch=main");
    await write(lonely, "README.md", "# lonely\n");
    await g(lonely, "add", "-A");
    await g(lonely, "commit", "--quiet", "-m", "one");

    const decision = await evaluateGate({
      cwd: lonely,
      policy: policy({ blockStaleRuns: true }),
      readOnly: true,
    });
    expect(decision.verdict.status).toBe("unknown");
    expect(decision.action).toBe("allow");
    expect(decision.exitCode).toBe(0);
  });

  it("answers unknown outside a repository altogether", async () => {
    const plain = join(tmp, "plain");
    await mkdir(plain, { recursive: true });
    const verdict = await checkSteeringFreshness({
      cwd: plain,
      policy: policy(),
    });
    expect(verdict.status).toBe("unknown");
  });
});

describe("the fetch throttle", () => {
  it("keeps its stamp out of .oxagen, in git's own directory", async () => {
    const fresh = join(tmp, "throttle");
    await g(tmp, "clone", "--quiet", origin, fresh);
    await checkSteeringFreshness({ cwd: fresh, policy: policy() });
    const stamp = await readFile(
      join(fresh, ".git", "oxagen", "steering-freshness.json"),
      "utf8",
    );
    expect(JSON.parse(stamp)).toMatchObject({ target: "origin/main" });
    // And the repository is still clean, which is the point.
    expect(await g(fresh, "status", "--porcelain")).toBe("");
  });
});

// An ignored file at a path production just added is a file the sync would
// overwrite. `git status` hides ignored files unless asked, so it read as no
// dirt at all and auto-sync replaced it with `force` false.
describe("an ignored local file where production added a record", () => {
  it("counts as dirt, so the sync refuses", async () => {
    await mergeContextPr("ctx.ignored.case", "Production's version");
    const path = ".oxagen/rules/ctx.ignored.case.toml";
    await write(work, path, "# the developer's own, ignored, copy\n");
    await write(work, ".git/info/exclude", `${path}\n`);
    const verdict = await checkSteeringFreshness({
      cwd: work,
      policy: policy(),
    });
    expect(verdict.dirty).toContain(path);
    const result = await syncSteering({ cwd: work, verdict, force: false });
    expect(result.applied).toBe(false);
    // `dirty`, or `diverged` when the branch also has its own commits, as it
    // does by this point in the file. Either way the file is not touched.
    expect(["dirty", "diverged"]).toContain(result.refusal);
    expect(await readFile(join(work, path), "utf8")).toContain(
      "the developer's own",
    );
  });
});

// A depth-limited clone holds both tips with their common ancestor below the
// shallow boundary, and `merge-base` answers nothing. That read as `unknown`,
// and an enforced gate allowed the prompt: a shallow feature clone was a way
// past `blockStaleRuns`.
describe("a shallow feature clone", () => {
  it("deepens until the common ancestor appears, and still sees the merged record", async () => {
    // A feature branch on origin, two commits past main's tip, so a depth-1
    // clone of it cannot reach where it forked from main.
    const author = join(tmp, "author-shallow");
    await g(tmp, "clone", "--quiet", origin, author);
    await g(author, "config", "user.name", "Test");
    await g(author, "config", "user.email", "test@example.invalid");
    await g(author, "checkout", "--quiet", "-b", "feature/shallow");
    await write(author, "src/one.ts", "export const one = 1;\n");
    await g(author, "add", "-A");
    await g(author, "commit", "--quiet", "-m", "one");
    await write(author, "src/two.ts", "export const two = 2;\n");
    await g(author, "add", "-A");
    await g(author, "commit", "--quiet", "-m", "two");
    await g(author, "push", "--quiet", "origin", "feature/shallow");
    // Then production gains a record the branch does not have.
    await mergeContextPr("ctx.shallow.case", "Published after the branch");

    const shallow = join(tmp, "shallow");
    await g(
      tmp,
      "clone",
      "--quiet",
      "--depth=1",
      "--branch=feature/shallow",
      `file://${origin}`,
      shallow,
    );
    expect(await g(shallow, "rev-parse", "--is-shallow-repository")).toBe(
      "true",
    );

    const verdict = await checkSteeringFreshness({
      cwd: shallow,
      policy: policy(),
    });
    expect(verdict.status, verdict.notes.join(" | ")).toBe("behind");
    expect(verdict.missing.map((c) => c.path)).toContain(
      ".oxagen/rules/ctx.shallow.case.toml",
    );
    expect(verdict.notes.join(" ")).toContain("deepened this shallow clone");
  });
});

// A cone-mode sparse checkout that leaves `.oxagen/` out keeps its entries in
// the index and removes the files. Nothing git compares noticed.
describe("a sparse checkout that excludes .oxagen", () => {
  it("is behind, so an enforced gate does not let the agent run without its records", async () => {
    const sparse = join(tmp, "sparse");
    await g(tmp, "clone", "--quiet", "--no-checkout", origin, sparse);
    await g(sparse, "sparse-checkout", "set", "src");
    await g(sparse, "checkout", "--quiet", "main");
    expect(existsSync(join(sparse, ".oxagen"))).toBe(false);

    const verdict = await checkSteeringFreshness({
      cwd: sparse,
      policy: policy(),
    });
    expect(verdict.status, verdict.notes.join(" | ")).toBe("behind");
    expect(verdict.missing.map((c) => c.path)).toContain(
      ".oxagen/rules/ctx.base.always.toml",
    );
  });
});

// `git rm` removes what the index knows. An untracked copy at a path
// production retired survived a forced sync, which then reported `applied`.
describe("a forced sync over an untracked copy of a retired record", () => {
  it("removes the copy too", async () => {
    // Retire a record on production.
    const author = join(tmp, "author-retire");
    await g(tmp, "clone", "--quiet", origin, author);
    await g(author, "config", "user.name", "Test");
    await g(author, "config", "user.email", "test@example.invalid");
    await g(author, "rm", "--quiet", ".oxagen/rules/ctx.base.always.toml");
    await g(author, "commit", "--quiet", "-m", "context: retire ctx.base.always");
    await g(author, "push", "--quiet", "origin", "main");

    // A fresh clone of the pre-retirement state, with the deletion staged
    // but the file left on disk, untracked.
    const forced = join(tmp, "forced");
    await g(tmp, "clone", "--quiet", origin, forced);
    await g(forced, "config", "user.name", "Test");
    await g(forced, "config", "user.email", "test@example.invalid");
    await g(forced, "checkout", "--quiet", "HEAD~1");
    await g(forced, "rm", "--quiet", "--cached", ".oxagen/rules/ctx.base.always.toml");
    const path = join(forced, ".oxagen/rules/ctx.base.always.toml");
    expect(existsSync(path)).toBe(true);

    const verdict = await checkSteeringFreshness({ cwd: forced, policy: policy() });
    expect(verdict.missing.map((c) => c.path)).toContain(
      ".oxagen/rules/ctx.base.always.toml",
    );
    const result = await syncSteering({ cwd: forced, verdict, force: true });
    expect(result.applied).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
