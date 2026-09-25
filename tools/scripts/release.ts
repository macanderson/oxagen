#!/usr/bin/env tsx
/**
 * release.ts — lockstep version release for the whole monorepo.
 *
 * Every workspace package is versioned in lockstep (one number for the entire
 * platform), so a release is: bump every package.json `version` to the same new
 * value, regenerate AI-written release notes from the git history since the last
 * tag, and commit + tag.
 *
 *   pnpm release:patch            # 0.1.0 -> 0.1.1
 *   pnpm release:minor            # 0.1.0 -> 0.2.0
 *   pnpm release:major            # 0.1.0 -> 1.0.0
 *   pnpm release:<bump>:publish   # the same, then build every platform in CI
 *                                 # and upload (tools/scripts/release-publish.ts)
 *   tsx tools/scripts/release.ts minor --dry-run     # show everything, write nothing
 *   tsx tools/scripts/release.ts --set 0.2.0         # set an exact version
 *
 * Flags:
 *   --dry-run     compute + print, but write no files, no git, no npm
 *   --set X.Y.Z   set an exact version instead of bumping
 *   --from <ref>  base ref for the notes diff (default: newest tag); use this to
 *                 regenerate notes for an already-tagged release, or when the
 *                 previous release was never tagged on main
 *   --highlight <text>
 *                 what the release leads with; the model opens the notes with
 *                 it, as far as the diff supports it
 *   --no-notes    skip the Anthropic release-notes generation (plain changelog)
 *   --no-git      skip the commit + tag. Without it, the tree must be clean
 *                 before the run starts, and the commit stages only the files
 *                 this script wrote, so nothing else in the tree can ride along
 *   --no-npm      skip the CLI build + npm publish (even if NPM_TOKEN is available)
 *   --written-list <path>
 *                 write the repo-relative paths of every file this run wrote,
 *                 one per line, to <path> (keep it outside the tree). A caller
 *                 that passes --no-git and commits itself stages exactly these
 *                 with `git add -- <paths>`, never `git add -A`. The tree must
 *                 be clean before the run starts, as it must without --no-git
 *   --install-links
 *                 end the notes with an "## Install" section that links every
 *                 installer and executable of this version by its published
 *                 name (tools/scripts/lib/release-artifacts.ts); the publish
 *                 flow passes this, since it is what makes those files exist
 *   --yes         (reserved) non-interactive; this script is already non-interactive
 *
 * Release notes are written by a model from the commit log, diffstat and diff
 * between the last release tag and HEAD, through the Vercel AI Gateway
 * (AI_GATEWAY_API_KEY, model = OXAGEN_LLM_BALANCED, an Anthropic Claude model),
 * under the clear-prose and oxagen-branding skills, which are read from the
 * tree and handed to the model as its instructions (tools/scripts/lib/
 * release-notes.ts). The answer is checked with the docs' own prose scanner
 * and retried once with the findings; if the gateway is unreachable or the
 * model will not comply, a sanitised commit-log summary is written instead so
 * a release never blocks on AI availability. No SDK dependency.
 *
 * The notes land in three places: `releases/v<version>.md`, the top of
 * `CHANGELOG.md`, and `apps/docs/content/docs/releases/v<version>.mdx`, the
 * page on docs.oxagen.sh that carries the notes and the downloads for that
 * version (`releases/meta.json` is rewritten so the sidebar lists versions
 * newest first).
 *
 * `.github/workflows/release.yml` runs this on `workflow_dispatch` with
 * --no-git --no-npm and turns the result into a pull request; the merge of that
 * PR tags the release and builds the desktop app.
 *
 * This script no longer propagates PLATFORM_VERSION to the runtime. It used to
 * write the tag into every oxagen-v2-* Vercel project through the REST API;
 * production runs on AWS and that account is being decommissioned (#1295), so
 * the sync had nothing left to write to. Nothing on the AWS path sets the var
 * in its place, which means `platformVersion()` falls back to "0.0.0" in
 * production — a real gap, but one that belongs to the deploy pipeline (SSM
 * `/oxagen/production`), not to this script.
 *
 * Run via `pnpm release:<patch|minor|major>` (wraps this with --env-file-if-exists).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { argv, env, exit } from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import kleur from "kleur";
import { formatError } from "./lib/format-error";
import { npmCfg, publishCliToNpm } from "./lib/npm-cli";
import { installSection } from "./lib/release-artifacts";
import {
  changelogEntry,
  fallbackNotes,
  loadSkills,
  parseNotes,
  proseHits,
  releasePageMdx,
  releasesMeta,
  type ReleaseNotes,
  retryPrompt,
  systemPrompt,
  userPrompt,
} from "./lib/release-notes";
import {
  discoverManifests,
  readManifestVersion,
  setAllVersions,
} from "./lib/versions";

const ROOT = resolve(import.meta.dirname, "../..");
const NOTES_MAX_TOKENS = 8192; // headroom so large releases don't truncate mid-section
/**
 * How long one gateway call may take before it is aborted. A hung gateway
 * otherwise holds the release open indefinitely; the abort throws, and
 * generateNotes falls back to commit-log notes.
 */
export const GATEWAY_TIMEOUT_MS = 120_000;

type Bump = "patch" | "minor" | "major";

interface Options {
  bump: Bump | null;
  setVersion: string | null;
  fromRef: string | null;
  highlight: string | null;
  dryRun: boolean;
  notes: boolean;
  git: boolean;
  npm: boolean;
  installLinks: boolean;
  writtenList: string | null;
}

// ── small utilities ──────────────────────────────────────────────────────────

/** Env values pasted in from a dashboard arrive double-quoted; strip one pair. */
function deQuote(v: string | undefined): string {
  if (!v) return "";
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"')
    ? v.slice(1, -1)
    : v;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** Like `git`, but keeps leading whitespace, which porcelain status needs. */
function gitRaw(args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitSafe(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// ── the release commit's contents ───────────────────────────────────────────

/**
 * Throw when `git status --porcelain` reports anything. The release commit
 * must carry the bump and the notes and nothing else, so a modified, staged or
 * untracked file (a stray `.env` copy, a scratch file) stops the run before
 * any file is written. The message names every dirty path.
 */
export function assertCleanTree(porcelain: string): void {
  const dirty = porcelain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
  if (dirty.length === 0) return;
  throw new Error(
    `the tree has uncommitted changes. Commit or discard them first, because the release commit carries only the bump and the notes:\n${dirty.map((p) => `  ${p}`).join("\n")}`,
  );
}

/**
 * The text `--written-list` writes: the paths from `releaseFilesToStage`, one
 * per line, ending in a newline. A path holding a newline would split into two
 * entries, so it is refused rather than written.
 */
export function formatWrittenList(
  root: string,
  written: readonly string[],
): string {
  const paths = releaseFilesToStage(root, written);
  const bad = paths.find((p) => p.includes("\n"));
  if (bad !== undefined)
    throw new Error(`cannot list a path that holds a newline: ${bad}`);
  return paths.map((p) => `${p}\n`).join("");
}

/** Read a `--written-list` file back into its paths. */
export function parseWrittenList(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

/**
 * The paths the release commit stages: the manifests the bump rewrote and the
 * notes files, relative to the repository root, each once. Only files this
 * script wrote are listed, so `git add` never picks up an unrelated file.
 */
export function releaseFilesToStage(
  root: string,
  written: readonly string[],
): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const relative = written.map((p) =>
    p.startsWith(prefix) ? p.slice(prefix.length) : p,
  );
  return [...new Set(relative)];
}

function bumpVersion(current: string, bump: Bump): string {
  // Drop any prerelease/build metadata; lockstep releases are plain X.Y.Z.
  const core = current.split(/[-+]/)[0] ?? current;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  if (!m) throw new Error(`root version "${current}" is not semver X.Y.Z`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ── .env.local PLATFORM_VERSION sync (local mirror of the release tag) ───────

function syncLocalEnv(version: string): void {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const line = `PLATFORM_VERSION="${version}"`;
  const next = /^PLATFORM_VERSION=.*$/m.test(text)
    ? text.replace(/^PLATFORM_VERSION=.*$/m, line)
    : `${text.replace(/\n*$/, "")}\n${line}\n`;
  writeFileSync(file, next);
}

// ── release notes via the Anthropic Messages API ─────────────────────────────

interface NotesInput {
  fromRef: string;
  toRef: string;
  version: string;
  log: string;
  stat: string;
  diff: string;
  highlight: string | null;
}

function collectHistory(
  version: string,
  overrideFrom: string | null,
  highlight: string | null,
): NotesInput {
  // Base ref: explicit --from wins; otherwise the newest tag reachable from HEAD;
  // otherwise the root commit. (--from is how you regenerate notes for an
  // already-tagged release, where `git describe` would resolve to that tag.)
  const lastTag = gitSafe(["describe", "--tags", "--abbrev=0"]);
  const fromRef =
    overrideFrom ??
    lastTag ??
    git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0] ??
    "HEAD~1";
  const range = `${fromRef}..HEAD`;
  const log =
    gitSafe(["log", range, "--no-merges", "--pretty=format:- %s (%h)"]) ?? "";
  const stat = gitSafe(["diff", "--stat", range]) ?? "";
  // Cap the unified diff so the prompt stays bounded on large releases.
  const fullDiff = gitSafe(["diff", range]) ?? "";
  const MAX = 60_000;
  const diff =
    fullDiff.length > MAX
      ? `${fullDiff.slice(0, MAX)}\n…(diff truncated at ${MAX} chars)…`
      : fullDiff;
  return { fromRef, toRef: "HEAD", version, log, stat, diff, highlight };
}

/** Vercel AI Gateway (AI_GATEWAY_API_KEY): the platform's single AI path. Hits
 * an Anthropic Claude model (OXAGEN_LLM_BALANCED) via the gateway's
 * OpenAI-compatible endpoint. Returns null when no gateway key is configured.
 * The request and its body read are aborted after `timeoutMs`, which rejects
 * with a `TimeoutError`. */
export async function completeViaGateway(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<string | null> {
  const key = deQuote(env.AI_GATEWAY_API_KEY);
  if (!key) return null;
  const model = deQuote(env.OXAGEN_LLM_BALANCED) || "anthropic/claude-sonnet-5";
  const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: NOTES_MAX_TOKENS,
      temperature: 0.2,
      messages,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`gateway ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("gateway empty completion");
  console.log(kleur.dim(`[release]   (via AI Gateway model ${model})`));
  return text;
}

/**
 * Notes from the model under the two writing skills, checked by the prose
 * scanner and retried once with its findings; the commit-log fallback when
 * the gateway is absent, fails, or answers in the wrong shape twice.
 */
async function generateNotes(h: NotesInput): Promise<ReleaseNotes> {
  const fallback = () => fallbackNotes(h);
  let system: string;
  try {
    system = systemPrompt(loadSkills(ROOT));
  } catch (err) {
    console.log(
      kleur.yellow(`[release] ${formatError(err)}; using commit-log notes.`),
    );
    return fallback();
  }
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    { role: "system", content: system },
    { role: "user", content: userPrompt(h) },
  ];
  try {
    const first = await completeViaGateway(messages);
    if (first === null) {
      console.log(
        kleur.yellow(
          "[release] AI_GATEWAY_API_KEY not set; using commit-log notes.",
        ),
      );
      return fallback();
    }
    let notes = parseNotes(first);
    if (notes === null) {
      console.log(
        kleur.yellow(
          "[release] the model's answer was not in the expected shape; asking once more.",
        ),
      );
      messages.push({ role: "assistant", content: first });
      messages.push({
        role: "user",
        content:
          "That is not the shape asked for. Answer again with exactly: a `SUMMARY:` line, a blank line, then `## What changed` and the notes. Nothing else.",
      });
      const second = await completeViaGateway(messages);
      notes = second === null ? null : parseNotes(second);
      if (notes === null) {
        console.log(
          kleur.yellow("[release] still not in shape; using commit-log notes."),
        );
        return fallback();
      }
    }
    let hits = proseHits(notes);
    if (hits.length > 0) {
      console.log(
        kleur.yellow(
          `[release] prose scanner: ${hits.length} finding(s); asking for a rewrite.`,
        ),
      );
      for (const hit of hits) console.log(kleur.dim(`    ${hit}`));
      messages.push({
        role: "assistant",
        content: `SUMMARY: ${notes.summary}\n\n${notes.body}`,
      });
      messages.push({ role: "user", content: retryPrompt(notes, hits) });
      const rewritten = await completeViaGateway(messages);
      const parsed = rewritten === null ? null : parseNotes(rewritten);
      if (parsed !== null) {
        const again = proseHits(parsed);
        if (again.length <= hits.length) {
          notes = parsed;
          hits = again;
        }
      }
    }
    if (hits.length > 0) {
      // The PR that carries these notes runs the same scanner in CI and fails
      // on them, which is the right place for a person to read and fix a line
      // a model could not. Say so here rather than hide it.
      console.log(
        kleur.yellow(
          `[release] ${hits.length} prose finding(s) remain; the release PR's check:prose will name them:`,
        ),
      );
      for (const hit of hits) console.log(kleur.yellow(`    ${hit}`));
    }
    console.log(
      kleur.green(
        "[release] release notes written by the model under the writing skills.",
      ),
    );
    return notes;
  } catch (err) {
    console.log(
      kleur.yellow(
        `[release] AI Gateway failed (${formatError(err)}); using commit-log notes.`,
      ),
    );
    return fallback();
  }
}

const DOCS_RELEASES_DIR = join(ROOT, "apps/docs/content/docs/releases");

/**
 * The changelog entry, plus the install links when the publish flow asked for
 * them (`--install-links`). Every artifact of the release is named from the
 * version alone, so the links are written before CI has built the files.
 */
function releaseBody(
  version: string,
  notes: ReleaseNotes,
  install: string | null,
): string {
  const entry = changelogEntry(version, notes);
  return install === null ? entry : `${entry.trimEnd()}\n\n${install}\n`;
}

function writeNotes(
  version: string,
  notes: ReleaseNotes,
  install: string | null,
): { changelog: string; release: string; page: string; meta: string } {
  const entry = releaseBody(version, notes, install);
  const releasesDir = join(ROOT, "releases");
  mkdirSync(releasesDir, { recursive: true });
  const releaseFile = join(releasesDir, `v${version}.md`);
  writeFileSync(
    releaseFile,
    `# v${version}\n\n${entry.replace(/^## v[^\n]*\n\n/, "")}`,
  );

  // The changelog always carries exactly one `# Changelog` title, whether or not
  // the prior file had one; the newest release is inserted directly beneath it.
  const changelogFile = join(ROOT, "CHANGELOG.md");
  const prior = existsSync(changelogFile)
    ? readFileSync(changelogFile, "utf8")
    : "# Changelog\n";
  const rest = prior.replace(/^#\s*Changelog\s*\n?/, "");
  writeFileSync(
    changelogFile,
    `# Changelog\n\n${entry.trim()}\n\n${rest.trimStart()}`,
  );

  // The docs page, and the sidebar order that lists it first.
  mkdirSync(DOCS_RELEASES_DIR, { recursive: true });
  const page = join(DOCS_RELEASES_DIR, `v${version}.mdx`);
  writeFileSync(
    page,
    releasePageMdx({
      version,
      date: new Date().toISOString().slice(0, 10),
      notes,
    }),
  );
  const meta = join(DOCS_RELEASES_DIR, "meta.json");
  writeFileSync(
    meta,
    releasesMeta(existsSync(meta) ? readFileSync(meta, "utf8") : null, version),
  );
  return { changelog: changelogFile, release: releaseFile, page, meta };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(): Options {
  const args = argv.slice(2);
  const opts: Options = {
    bump: null,
    setVersion: null,
    fromRef: null,
    highlight: null,
    dryRun: false,
    notes: true,
    git: true,
    npm: true,
    installLinks: false,
    writtenList: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "patch" || a === "minor" || a === "major") opts.bump = a;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-notes") opts.notes = false;
    else if (a === "--no-git") opts.git = false;
    else if (a === "--no-npm") opts.npm = false;
    else if (a === "--install-links") opts.installLinks = true;
    else if (a === "--yes") {
      /* non-interactive already */
    } else if (a === "--set") opts.setVersion = args[++i] ?? null;
    else if (a.startsWith("--set=")) opts.setVersion = a.slice("--set=".length);
    else if (a === "--from") opts.fromRef = args[++i] ?? null;
    else if (a.startsWith("--from=")) opts.fromRef = a.slice("--from=".length);
    else if (a === "--written-list") opts.writtenList = args[++i] ?? null;
    else if (a.startsWith("--written-list="))
      opts.writtenList = a.slice("--written-list=".length);
    else if (a === "--highlight") opts.highlight = args[++i] ?? null;
    else if (a.startsWith("--highlight="))
      opts.highlight = a.slice("--highlight=".length);
    else {
      console.error(kleur.red(`[release] unknown argument: ${a}`));
      exit(2);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (!opts.bump && !opts.setVersion) {
    console.error(
      kleur.red(
        "[release] usage: release.ts <patch|minor|major> [--set X.Y.Z] [--from <ref>] [--highlight <text>] [--dry-run] [--no-notes|--no-git|--no-npm] [--written-list <path>]",
      ),
    );
    exit(2);
  }

  const rootPkg = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as { version: string };
  const current = rootPkg.version;
  const next = opts.setVersion ?? bumpVersion(current, opts.bump as Bump);
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error(
      kleur.red(`[release] target version "${next}" is not semver X.Y.Z`),
    );
    exit(2);
  }

  console.log(
    kleur.bold(
      `\n  Oxagen release  ${kleur.cyan(current)} → ${kleur.green(next)}${opts.dryRun ? kleur.yellow("  (dry run)") : ""}\n`,
    ),
  );

  // The commit must hold only what this run writes, so check before the first
  // write. That commit is this script's own, or, with --written-list, the
  // caller's (release-publish.ts, release.yml). A dry run writes nothing and
  // only warns.
  if (opts.git || opts.writtenList !== null) {
    try {
      assertCleanTree(gitRaw(["status", "--porcelain"]));
    } catch (err) {
      if (!opts.dryRun) throw err;
      console.log(kleur.yellow(`  ${formatError(err)} (dry run: continuing)`));
    }
  }
  const toStage: string[] = [];

  // Every manifest, whatever its language: package.json, Cargo.toml, the
  // crate's Cargo.lock entry (tools/scripts/lib/versions.ts). CI's
  // check:versions fails when any of them drifts from the root.
  if (opts.dryRun) {
    const manifests = discoverManifests(ROOT);
    console.log(kleur.bold(`  Manifests (${manifests.length}):`));
    for (const m of manifests) {
      const from = readManifestVersion(ROOT, m);
      console.log(
        `    ${kleur.dim(from ?? "?")} → ${kleur.green(next)}  ${m.name} (${m.file})`,
      );
    }
  } else {
    const written = setAllVersions(ROOT, next);
    for (const m of written) toStage.push(m.file);
    console.log(kleur.bold(`  Manifests (${written.length}):`));
    for (const m of written)
      console.log(
        `    ${kleur.dim(m.from ?? "(none)")} → ${kleur.green(next)}  ${m.name} (${m.file})`,
      );
  }
  if (!opts.dryRun) syncLocalEnv(next);

  // ── Release notes ──
  let notes: ReleaseNotes | null = null;
  // The docs page renders its downloads through <ReleaseDownloads>, so the
  // install links belong only to the copies that carry no component: the
  // release file, the changelog entry, and the tag body that
  // release-publish.ts reuses for the GitHub release.
  const install = opts.installLinks ? installSection(next) : null;
  if (opts.notes) {
    console.log(kleur.bold("\n  Release notes:"));
    const history = collectHistory(next, opts.fromRef, opts.highlight);
    console.log(kleur.dim(`    history range: ${history.fromRef}..HEAD`));
    notes = await generateNotes(history);
    if (!opts.dryRun) {
      const written = writeNotes(next, notes, install);
      toStage.push(
        written.release,
        written.changelog,
        written.page,
        written.meta,
      );
      console.log(
        kleur.green(
          `    ✓ ${written.release.replace(ROOT + "/", "")}  +  CHANGELOG.md  +  ${written.page.replace(ROOT + "/", "")}`,
        ),
      );
    } else {
      // Print what would be written, install links and all, so --dry-run is a
      // preview of the file and not of the model's answer alone.
      console.log(
        kleur.dim(
          "\n" +
            releaseBody(next, notes, install)
              .split("\n")
              .map((l) => "    │ " + l)
              .join("\n"),
        ),
      );
    }
  }

  if (opts.writtenList !== null && !opts.dryRun) {
    writeFileSync(opts.writtenList, formatWrittenList(ROOT, toStage));
  }

  // ── Git commit + tag ──
  if (opts.git && !opts.dryRun) {
    console.log(kleur.bold("\n  Git:"));
    git(["add", "--", ...releaseFilesToStage(ROOT, toStage)]);
    git(["commit", "-m", `chore(release): v${next}`]);
    const tagBody =
      notes === null
        ? `Release v${next}`
        : releaseBody(next, notes, install).trim();
    git(["tag", "-a", `v${next}`, "-m", tagBody]);
    console.log(kleur.green(`    ✓ committed + tagged v${next}`));
    console.log(kleur.dim("    (push with: git push && git push --tags)"));
  } else if (opts.git) {
    console.log(kleur.dim("\n  Git: would commit + tag v" + next));
  }

  // ── npm CLI publish ──
  if (opts.npm && !opts.dryRun) {
    await publishCliToNpm(next);
  } else if (opts.npm && opts.dryRun) {
    const cfg = npmCfg();
    if (cfg)
      console.log(
        kleur.dim(
          "\n  npm CLI publish: would build and publish @oxagen/cli to npm",
        ),
      );
  }

  console.log(
    kleur.bold(
      kleur.green(
        `\n  ✓ release ${next} ${opts.dryRun ? "previewed" : "prepared"}\n`,
      ),
    ),
  );
}

// Run only when invoked as a script, so a test can import the helpers above.
const invokedDirectly =
  argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(
      kleur.red(
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      ),
    );
    exit(1);
  });
}
