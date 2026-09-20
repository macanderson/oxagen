#!/usr/bin/env tsx
/**
 * release-publish.ts: cut a release from this machine and put every
 * distributable of it where people install from.
 *
 *   pnpm release:patch:publish
 *   pnpm release:minor:publish
 *   pnpm release:major:publish
 *   pnpm release:publish --set 2.3.0
 *   pnpm release:publish --dry-run          # show the version and the notes, write nothing
 *   pnpm release:publish --publish-only     # the tags exist; wait for CI and upload
 *
 * All three bumps do the same thing and differ only in the number:
 *
 *   1. Find the last published version: the newest non-draft GitHub release
 *      whose tag is `vX.Y.Z` or `desktop-vX.Y.Z`. The notes diff from there,
 *      not from the newest tag, so a tag that never shipped is not a release
 *      boundary.
 *   2. Write the next version into every manifest in the tree, whatever its
 *      language (`tools/scripts/lib/versions.ts`), and have `release.ts` write
 *      the notes: a model's summary of the diff since the last published
 *      version, then an "## Install" section that links every installer and
 *      executable of this version by its published name.
 *   3. Commit `chore(release): vX.Y.Z` on `release/vX.Y.Z` (or the branch you
 *      are on, if it is not main), tag it `vX.Y.Z` and `desktop-vX.Y.Z`, push
 *      the branch and the tags, and open the pull request to main. main only
 *      takes pull requests; the tags are refs of their own and do not wait.
 *   4. The `desktop-v*` tag starts `.github/workflows/desktop.yml`, one job per
 *      OS, because the sidecars embed the runner's node and cannot be
 *      cross-compiled from here. Wait for it.
 *   5. Upload: the installers to downloads.oxagen.sh with their checksums and
 *      the listing page (`apps/desktop/scripts/publish-downloads.mjs`), and
 *      `@oxagen/cli` to npm from this tree (`tools/scripts/lib/npm-cli.ts`).
 *   6. Check that every file the notes link to is on the GitHub release, set
 *      the release's notes, and publish it. Publishing moves the in-app
 *      updater feed (`desktop.yml`, job `feed`).
 *
 * Steps 5 and 6 are also what `desktop.yml`'s `publish` job does on the tag,
 * so on a healthy run this script finds both already done and says so. It
 * does them itself because the job can fail on a credential this laptop
 * holds and the runner does not, and because the check in step 6 is the one
 * place a missing asset stops a release from being called published.
 *
 * Every step after the tags is idempotent: a version already on
 * downloads.oxagen.sh, on npm, or published on GitHub is left alone and
 * reported, so an interrupted run resumes with `--publish-only`, and a CI
 * job that publishes the same version first does no harm.
 *
 * Flags:
 *   --dry-run            preflight and preview; nothing is written or pushed
 *   --set X.Y.Z          an exact version instead of a bump
 *   --publish-only       skip the bump, commit, and tags (they exist); wait and upload
 *   --timeout-minutes N  how long to wait for the desktop build (default 120)
 *   --no-pr              push the branch and tags, open no pull request
 *   --no-npm             leave npm alone
 *   --no-downloads       leave downloads.oxagen.sh alone
 *   --no-notes           plain commit-log notes (no AI Gateway call)
 *
 * Needs: a clean tree, `gh` signed in, `aws` with credentials for the
 * downloads bucket, NPM_TOKEN in the environment or .env.local (unless
 * --no-npm), and AI_GATEWAY_API_KEY for model-written notes (falls back to
 * the commit log). The updater key is CI's (TAURI_SIGNING_PRIVATE_KEY secret).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argv, env, exit } from "node:process";
import kleur from "kleur";
import { npmVersionExists, publishCliToNpm } from "./lib/npm-cli";
import {
  DOWNLOADS_HOST,
  NPM_CLI_PACKAGE,
  expectedAssets,
  downloadUrl,
  releaseTag,
  releaseUrl,
} from "./lib/release-artifacts";
import { readRootVersion, versionDrift } from "./lib/versions";

const ROOT = resolve(import.meta.dirname, "../..");
const DOWNLOADS_BUCKET = "oxagen-downloads-916294258235";
const POLL_MS = 60_000;

type Bump = "patch" | "minor" | "major";

interface Options {
  bump: Bump | null;
  setVersion: string | null;
  dryRun: boolean;
  publishOnly: boolean;
  timeoutMinutes: number;
  pr: boolean;
  npm: boolean;
  downloads: boolean;
  notes: boolean;
}

// Colour-forcing variables in an interactive shell make `gh` emit ANSI
// escapes into JSON this script parses; every child gets colour turned off.
const CHILD_ENV = {
  ...env,
  NO_COLOR: "1",
  CLICOLOR: "0",
  CLICOLOR_FORCE: "0",
  FORCE_COLOR: "0",
  GH_FORCE_TTY: "",
  AWS_PAGER: "",
};

function sh(
  command: string,
  args: string[],
  opts: {
    capture?: boolean;
    allowFailure?: boolean;
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...CHILD_ENV, ...(opts.env ?? {}) },
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? "by signal"}`,
    );
  }
  return { status: result.status, stdout: (result.stdout ?? "").trim() };
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: CHILD_ENV,
  }).trim();
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(sh("gh", args, { capture: true }).stdout) as T;
}

function log(line: string): void {
  console.log(kleur.cyan("[publish] ") + line);
}

function step(title: string): void {
  console.log(kleur.bold(`\n  ${title}`));
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function bumpVersion(current: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`version "${current}" is not X.Y.Z`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ── what was published last ──────────────────────────────────────────────────

interface GhRelease {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

/** The newest published release, by the version in its tag. */
function lastPublished(): { version: string; tag: string } | null {
  const releases = ghJson<GhRelease[]>([
    "release",
    "list",
    "--limit",
    "200",
    "--json",
    "tagName,isDraft,isPrerelease",
  ]);
  let best: { version: string; tag: string } | null = null;
  for (const r of releases) {
    if (r.isDraft || r.isPrerelease) continue;
    const m = /^(?:desktop-)?v(\d+\.\d+\.\d+)$/.exec(r.tagName);
    if (!m?.[1]) continue;
    if (best === null || compareSemver(m[1], best.version) > 0)
      best = { version: m[1], tag: r.tagName };
  }
  return best;
}

// ── preflight ────────────────────────────────────────────────────────────────

function preflight(opts: Options): void {
  step("Preflight");
  if (git(["status", "--porcelain"]) !== "") {
    const message =
      "the tree has uncommitted changes; commit or discard them first (the release commit must carry only the bump and the notes)";
    if (!opts.dryRun) throw new Error(message);
    log(kleur.yellow(`${message} (dry run: continuing)`));
  }
  const drift = versionDrift(ROOT).drift;
  if (drift.length > 0 && !opts.publishOnly) {
    // The bump rewrites every manifest, so drift is repaired by it; say so.
    log(
      kleur.yellow(
        `${drift.length} manifest(s) are off the root version; the bump writes all of them`,
      ),
    );
  }
  if (
    sh("gh", ["auth", "status"], { capture: true, allowFailure: true })
      .status !== 0
  )
    throw new Error("`gh auth status` failed; sign in with `gh auth login`");
  log("gh: signed in");
  if (opts.downloads) {
    const who = sh("aws", ["sts", "get-caller-identity", "--output", "json"], {
      capture: true,
      allowFailure: true,
    });
    if (who.status !== 0)
      throw new Error(
        "`aws sts get-caller-identity` failed; the downloads publish needs AWS credentials (or pass --no-downloads)",
      );
    const arn = (JSON.parse(who.stdout) as { Arn?: string }).Arn ?? "?";
    log(`aws: ${arn}`);
  }
  if (opts.npm && !env.NPM_TOKEN)
    throw new Error(
      "NPM_TOKEN is not set; put it in .env.local or pass --no-npm",
    );
  if (opts.notes && !env.AI_GATEWAY_API_KEY)
    log(
      kleur.yellow(
        "AI_GATEWAY_API_KEY is not set; the notes will be the commit log",
      ),
    );
  git(["fetch", "origin", "--tags", "--prune", "--quiet"]);
}

// ── the desktop build ────────────────────────────────────────────────────────

interface GhRun {
  databaseId: number;
  status: string;
  conclusion: string | null;
  url: string;
  headSha: string;
}

function findRun(tag: string): GhRun | null {
  const runs = ghJson<GhRun[]>([
    "run",
    "list",
    "--workflow",
    "desktop.yml",
    "--branch",
    tag,
    "--event",
    "push",
    "--limit",
    "5",
    "--json",
    "databaseId,status,conclusion,url,headSha",
  ]);
  return runs[0] ?? null;
}

async function waitForBuild(
  tag: string,
  timeoutMinutes: number,
): Promise<GhRun> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let announced: number | null = null;
  for (;;) {
    const run = findRun(tag);
    if (run !== null) {
      if (announced !== run.databaseId) {
        log(`desktop.yml run ${run.databaseId}: ${run.url}`);
        announced = run.databaseId;
      }
      if (run.status === "completed") {
        if (run.conclusion === "success") return run;
        throw new Error(
          `the desktop build ${run.conclusion ?? "did not succeed"}: ${run.url}\n` +
            `  Fix the cause, re-run the failed jobs (gh run rerun ${run.databaseId} --failed), then resume with --publish-only.`,
        );
      }
      log(`  ${run.status}; checking again in ${POLL_MS / 1000}s`);
    } else {
      log(
        `no desktop.yml run for ${tag} yet; checking again in ${POLL_MS / 1000}s`,
      );
    }
    if (Date.now() > deadline)
      throw new Error(
        `gave up waiting for the desktop build after ${timeoutMinutes} minutes; resume with --publish-only when it is green`,
      );
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ── publish ──────────────────────────────────────────────────────────────────

/** True when `desktop/<version>/` already holds objects (published before). */
function downloadsPublished(version: string): boolean {
  const probe = sh(
    "aws",
    [
      "s3api",
      "list-objects-v2",
      "--bucket",
      DOWNLOADS_BUCKET,
      "--prefix",
      `desktop/${version}/`,
      "--max-keys",
      "1",
      "--output",
      "json",
      "--no-cli-pager",
    ],
    { capture: true, allowFailure: true },
  );
  if (probe.status !== 0)
    throw new Error(
      "could not list the downloads bucket; the publish cannot tell whether this version is already there",
    );
  const parsed = JSON.parse(probe.stdout || "{}") as { KeyCount?: number };
  return (parsed.KeyCount ?? 0) > 0;
}

interface GhReleaseView {
  isDraft: boolean;
  url: string;
  assets: Array<{ name: string }>;
}

function viewRelease(tag: string): GhReleaseView | null {
  const r = sh("gh", ["release", "view", tag, "--json", "isDraft,url,assets"], {
    capture: true,
    allowFailure: true,
  });
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout) as GhReleaseView;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(): Options {
  const args = argv.slice(2);
  const opts: Options = {
    bump: null,
    setVersion: null,
    dryRun: false,
    publishOnly: false,
    timeoutMinutes: 120,
    pr: true,
    npm: true,
    downloads: true,
    notes: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "patch" || a === "minor" || a === "major") opts.bump = a;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--publish-only") opts.publishOnly = true;
    else if (a === "--no-pr") opts.pr = false;
    else if (a === "--no-npm") opts.npm = false;
    else if (a === "--no-downloads") opts.downloads = false;
    else if (a === "--no-notes") opts.notes = false;
    else if (a === "--set") opts.setVersion = args[++i] ?? null;
    else if (a.startsWith("--set=")) opts.setVersion = a.slice("--set=".length);
    else if (a === "--timeout-minutes") opts.timeoutMinutes = Number(args[++i]);
    else if (a.startsWith("--timeout-minutes="))
      opts.timeoutMinutes = Number(a.slice("--timeout-minutes=".length));
    else {
      console.error(kleur.red(`[publish] unknown argument: ${a}`));
      exit(2);
    }
  }
  if (!opts.publishOnly && !opts.bump && !opts.setVersion) {
    console.error(
      kleur.red(
        "[publish] usage: release-publish.ts <patch|minor|major> [--set X.Y.Z] [--dry-run] [--publish-only] [--timeout-minutes N] [--no-pr|--no-npm|--no-downloads|--no-notes]",
      ),
    );
    exit(2);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  preflight(opts);

  // ── 1. versions ──
  step("Versions");
  const current = readRootVersion(ROOT);
  const last = lastPublished();
  log(
    last
      ? `last published: ${last.version} (${last.tag})`
      : "no published release on GitHub yet; the notes diff from the root commit",
  );
  const version = opts.publishOnly
    ? current
    : (opts.setVersion ?? bumpVersion(current, opts.bump as Bump));
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`"${version}" is not a release version (X.Y.Z)`);
  if (last && compareSemver(version, last.version) <= 0)
    throw new Error(
      `${version} is not newer than the last published ${last.version}`,
    );
  const tag = releaseTag(version);
  const platformTag = `v${version}`;
  log(`this release: ${kleur.green(version)} (tags ${platformTag}, ${tag})`);

  const tagExists = (t: string) =>
    sh(
      "git",
      ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${t}`],
      {
        capture: true,
        allowFailure: true,
      },
    ).status === 0;

  if (opts.publishOnly) {
    if (!tagExists(tag))
      throw new Error(
        `--publish-only, but ${tag} is not on origin; run without it to cut the release`,
      );
  } else if (tagExists(tag) || tagExists(platformTag)) {
    throw new Error(
      `${tag} or ${platformTag} already exists on origin. A published version never changes: pick the next number, or resume this one with --publish-only.`,
    );
  }

  // ── 2. bump + notes (release.ts owns both) ──
  const notesFile = join(ROOT, "releases", `v${version}.md`);
  if (!opts.publishOnly) {
    step("Bump every manifest and write the notes");
    const releaseArgs = [
      "tools/scripts/release.ts",
      "--set",
      version,
      "--no-git",
      "--no-vercel",
      "--no-npm",
      "--install-links",
      ...(last ? ["--from", last.tag] : []),
      ...(opts.dryRun ? ["--dry-run"] : []),
    ];
    // --no-notes here means the commit-log notes, not no notes: the file must
    // exist for the tags, the PR, and the GitHub release. release.ts writes
    // the commit log whenever it has no gateway key.
    sh("pnpm", ["exec", "tsx", ...releaseArgs], {
      env: opts.notes ? {} : { AI_GATEWAY_API_KEY: "" },
    });
    if (opts.dryRun) {
      console.log(
        kleur.bold(
          kleur.green(`\n  ✓ dry run: ${version} previewed, nothing written\n`),
        ),
      );
      return;
    }
    if (!existsSync(notesFile))
      throw new Error(`release.ts wrote no ${notesFile}`);

    // ── 3. commit, tags, push, PR ──
    step("Commit, tag, push");
    let branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "main" || branch === "HEAD") {
      branch = `release/v${version}`;
      git(["switch", "-c", branch]);
    }
    git(["add", "-A"]);
    git(["commit", "-m", `chore(release): v${version}`]);
    const notes = readFileSync(notesFile, "utf8");
    for (const t of [platformTag, tag]) git(["tag", "-a", t, "-F", notesFile]);
    // Explicit refspecs: a `push -u` from a branch cut off origin/main can
    // resolve to main under push.default=upstream.
    git(["push", "origin", `HEAD:refs/heads/${branch}`]);
    git(["push", "origin", `refs/tags/${platformTag}`, `refs/tags/${tag}`]);
    log(`pushed ${branch}, ${platformTag}, ${tag}`);

    if (opts.pr) {
      const open = ghJson<Array<{ url: string }>>([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "url",
      ]);
      if (open[0]) {
        log(`pull request already open: ${open[0].url}`);
      } else {
        const body = join(tmpdir(), `oxagen-release-${version}.md`);
        writeFileSync(
          body,
          [
            `Release v${version}. The tags \`${platformTag}\` and \`${tag}\` point at this commit; \`desktop.yml\` builds the installers from it and \`pnpm release:publish\` uploads them to downloads.oxagen.sh, npm, and the GitHub release.`,
            "",
            `Every manifest moves to ${version} (\`pnpm check:versions\` holds them there). The notes below are written from the diff since ${last?.tag ?? "the first commit"}; read them once before this merges.`,
            "",
            notes.replace(/^# v[\d.]+\s*\n/, ""),
          ].join("\n"),
        );
        const pr = sh(
          "gh",
          [
            "pr",
            "create",
            "--base",
            "main",
            "--head",
            branch,
            "--title",
            `chore(release): v${version}`,
            "--body-file",
            body,
            "--label",
            "no-issue",
          ],
          { capture: true },
        );
        log(`pull request: ${pr.stdout}`);
      }
    }
  } else {
    step("Resuming");
    const head = git(["rev-parse", "HEAD"]);
    const tagged = git(["rev-list", "-n", "1", tag]);
    if (head !== tagged)
      throw new Error(
        `HEAD is ${head.slice(0, 9)} but ${tag} is ${tagged.slice(0, 9)}; check out the tag so the npm bundle and the notes match the build`,
      );
    if (!existsSync(notesFile)) throw new Error(`${notesFile} is missing`);
  }

  // ── 4. wait for CI ──
  step("Desktop build (CI, all four targets)");
  const run = await waitForBuild(tag, opts.timeoutMinutes);
  log(kleur.green(`build green: ${run.url}`));

  const problems: string[] = [];

  // ── 5. downloads.oxagen.sh ──
  if (opts.downloads) {
    step(`Installers → https://${DOWNLOADS_HOST}/desktop/${version}/`);
    if (downloadsPublished(version)) {
      log(`already published; leaving it (a published version never changes)`);
    } else {
      sh("node", [
        "apps/desktop/scripts/publish-downloads.mjs",
        "--run",
        String(run.databaseId),
        "--version",
        version,
      ]);
    }
  }

  // ── 6. npm ──
  if (opts.npm) {
    step(`${NPM_CLI_PACKAGE}@${version} → npm`);
    if (npmVersionExists(version)) {
      log("already on the registry; leaving it");
    } else {
      await publishCliToNpm(version);
    }
  }

  // ── 7. the GitHub release: every linked file present, notes set, published ──
  step(`GitHub release ${tag}`);
  const release = viewRelease(tag);
  if (release === null)
    throw new Error(
      `no GitHub release for ${tag}; desktop.yml creates it as a draft on the tag push`,
    );
  const present = new Set(release.assets.map((a) => a.name));
  const expected = expectedAssets(version);
  const missing = [
    ...expected.installers,
    ...expected.binaries,
    ...expected.checksums,
  ].filter((name) => !present.has(name));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} asset(s) the notes link to are not on ${release.url}:\n    ${missing.join("\n    ")}`,
    );
    log(kleur.red(problems[problems.length - 1] ?? ""));
  } else {
    log(
      `${present.size} assets present, including every one the notes link to`,
    );
  }
  if (!present.has("latest.json"))
    log(
      kleur.yellow(
        "no latest.json: built without the updater key; the in-app updater will not see this version",
      ),
    );

  if (release.isDraft) {
    if (missing.length > 0) {
      log(
        kleur.yellow(
          "left as a draft until the missing assets are attached; then rerun with --publish-only",
        ),
      );
    } else {
      sh("gh", [
        "release",
        "edit",
        tag,
        "--title",
        `Oxagen v${version}`,
        "--notes-file",
        notesFile,
        "--draft=false",
        "--latest",
      ]);
      log(kleur.green(`published ${release.url}`));
    }
  } else {
    log("already published; notes left as they are");
  }

  // ── summary ──
  console.log(kleur.bold("\n  Where it is:"));
  console.log(`    ${releaseUrl(version)}`);
  for (const f of expected.installers)
    console.log(`    ${downloadUrl(version, f)}`);
  console.log(`    ${downloadUrl(version, "SHA256SUMS.txt")}`);
  console.log(
    `    https://www.npmjs.com/package/${NPM_CLI_PACKAGE}/v/${version}`,
  );
  console.log(`    ${notesFile.replace(`${ROOT}/`, "")}`);

  if (problems.length > 0) {
    console.error(
      kleur.red(
        `\n  ✖ release ${version} is incomplete:\n  ${problems.join("\n  ")}\n`,
      ),
    );
    exit(1);
  }
  console.log(kleur.bold(kleur.green(`\n  ✓ release ${version} published\n`)));
}

main().catch((err) => {
  console.error(
    kleur.red(err instanceof Error ? (err.stack ?? err.message) : String(err)),
  );
  exit(1);
});
