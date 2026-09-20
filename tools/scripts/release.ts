#!/usr/bin/env tsx
/**
 * release.ts — lockstep version release for the whole monorepo.
 *
 * Every manifest is versioned in lockstep (one number for the entire platform,
 * whatever the language: package.json, Cargo.toml, Cargo.lock; see
 * tools/scripts/lib/versions.ts), so a release is: write the same new version
 * into all of them, regenerate AI-written release notes from the git history since the last
 * tag, commit + tag, and propagate the new platform version to Vercel as the
 * `PLATFORM_VERSION` env var across every oxagen-v2 project and every
 * environment (development / preview / production).
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
 *   --dry-run     compute + print, but write no files, no git, no Vercel, no npm
 *   --set X.Y.Z   set an exact version instead of bumping
 *   --from <ref>  base ref for the notes diff (default: newest tag); use this to
 *                 regenerate notes for an already-tagged release
 *   --no-notes    skip the Anthropic release-notes generation (plain changelog)
 *   --no-git      skip the commit + tag
 *   --no-vercel   skip the Vercel PLATFORM_VERSION sync
 *   --no-npm      skip the CLI build + npm publish (even if NPM_TOKEN is available)
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
 * --no-git --no-vercel --no-npm and turns the result into a pull request; the
 * merge of that PR tags the release and builds the desktop app.
 *
 * Vercel sync uses the REST API (VERCEL_TOKEN + VERCEL_TEAM_ID) because the
 * Vercel CLI can't set "all preview branches" non-interactively. PLATFORM_VERSION
 * is a plain (non-secret) tag.
 *
 * Run via `pnpm release:<patch|minor|major>` (wraps this with --env-file-if-exists).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { argv, env, exit } from "node:process";
import { join, resolve } from "node:path";
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
const DEFAULT_TEAM_ID = "team_DiMizWNDHKFFU5ajKe2ZVKl9";
const VERCEL_PROJECT_PREFIX = "oxagen-v2-"; // the live v2 stack; v1 projects are left alone
const PLATFORM_ENVS = ["development", "preview", "production"] as const;
const NOTES_MAX_TOKENS = 8192; // headroom so large releases don't truncate mid-section

type Bump = "patch" | "minor" | "major";

interface Options {
  bump: Bump | null;
  setVersion: string | null;
  fromRef: string | null;
  dryRun: boolean;
  notes: boolean;
  git: boolean;
  vercel: boolean;
  npm: boolean;
  installLinks: boolean;
}

// ── small utilities ──────────────────────────────────────────────────────────

/** Env values pasted into a Vercel dashboard arrive double-quoted; strip one pair. */
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

function gitSafe(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
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

// ── .env.local PLATFORM_VERSION sync (local mirror of the Vercel tag) ─────────

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
}

function collectHistory(
  version: string,
  overrideFrom: string | null,
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
  return { fromRef, toRef: "HEAD", version, log, stat, diff };
}

/** Vercel AI Gateway (AI_GATEWAY_API_KEY): the platform's single AI path. Hits
 * an Anthropic Claude model (OXAGEN_LLM_BALANCED) via the gateway's
 * OpenAI-compatible endpoint. Returns null when no gateway key is configured. */
async function completeViaGateway(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
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
): { changelog: string; release: string; page: string } {
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
  return { changelog: changelogFile, release: releaseFile, page };
}

// ── Vercel PLATFORM_VERSION propagation (REST; all v2 projects × all envs) ────

interface VercelProject {
  id: string;
  name: string;
}

/** Authoritative team id from the linked project file; env/default are fallbacks
 * (the env var is historically typo-prone — see VERCEL_TEAM_ID trailing-E bug). */
function resolveTeamId(): string {
  const linked = join(ROOT, ".vercel/project.json");
  if (existsSync(linked)) {
    try {
      const orgId = (
        JSON.parse(readFileSync(linked, "utf8")) as { orgId?: string }
      ).orgId;
      if (orgId) return orgId;
    } catch {
      /* fall through to env/default */
    }
  }
  return deQuote(env.VERCEL_TEAM_ID) || DEFAULT_TEAM_ID;
}

function vercelCfg(): { token: string; teamId: string } | null {
  const token = deQuote(env.VERCEL_TOKEN) || deQuote(env.TURBO_TOKEN);
  if (!token) {
    console.log(
      kleur.yellow("[release] VERCEL_TOKEN not set — skipping Vercel sync."),
    );
    return null;
  }
  return { token, teamId: resolveTeamId() };
}

async function vercelFetch(
  cfg: { token: string; teamId: string },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`https://api.vercel.com${path}${sep}teamId=${cfg.teamId}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function listV2Projects(cfg: {
  token: string;
  teamId: string;
}): Promise<VercelProject[]> {
  const res = await vercelFetch(cfg, "/v9/projects?limit=100");
  if (!res.ok)
    throw new Error(`list projects: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { projects?: VercelProject[] };
  return (json.projects ?? []).filter((p) =>
    p.name.startsWith(VERCEL_PROJECT_PREFIX),
  );
}

async function upsertPlatformVersion(
  cfg: { token: string; teamId: string },
  project: VercelProject,
  version: string,
): Promise<void> {
  // Remove any existing all-branches PLATFORM_VERSION on every target, then POST
  // a single plain value scoped to all three targets. Idempotent re-run safe.
  const listRes = await vercelFetch(cfg, `/v9/projects/${project.id}/env`);
  if (!listRes.ok)
    throw new Error(
      `${project.name} list env: ${listRes.status} ${await listRes.text()}`,
    );
  const envs =
    (
      (await listRes.json()) as {
        envs?: Array<{ id: string; key: string; gitBranch?: string }>;
      }
    ).envs ?? [];
  for (const e of envs.filter(
    (e) => e.key === "PLATFORM_VERSION" && !e.gitBranch,
  )) {
    const del = await vercelFetch(
      cfg,
      `/v10/projects/${project.id}/env/${e.id}`,
      { method: "DELETE" },
    );
    if (!del.ok)
      throw new Error(
        `${project.name} delete: ${del.status} ${await del.text()}`,
      );
  }
  const post = await vercelFetch(cfg, `/v10/projects/${project.id}/env`, {
    method: "POST",
    body: JSON.stringify({
      key: "PLATFORM_VERSION",
      value: version,
      type: "plain",
      target: [...PLATFORM_ENVS],
    }),
  });
  if (!post.ok)
    throw new Error(
      `${project.name} post: ${post.status} ${await post.text()}`,
    );
}

async function syncVercel(version: string): Promise<void> {
  const cfg = vercelCfg();
  if (!cfg) return;
  const projects = await listV2Projects(cfg);
  if (projects.length === 0) {
    console.log(
      kleur.yellow(
        "[release] no oxagen-v2-* projects found on the team — nothing to sync.",
      ),
    );
    return;
  }
  for (const p of projects) {
    await upsertPlatformVersion(cfg, p, version);
    console.log(
      kleur.green(
        `[release]   ✓ ${p.name} PLATFORM_VERSION=${version} (dev+preview+prod)`,
      ),
    );
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(): Options {
  const args = argv.slice(2);
  const opts: Options = {
    bump: null,
    setVersion: null,
    fromRef: null,
    dryRun: false,
    notes: true,
    git: true,
    vercel: true,
    npm: true,
    installLinks: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "patch" || a === "minor" || a === "major") opts.bump = a;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-notes") opts.notes = false;
    else if (a === "--no-git") opts.git = false;
    else if (a === "--no-vercel") opts.vercel = false;
    else if (a === "--no-npm") opts.npm = false;
    else if (a === "--install-links") opts.installLinks = true;
    else if (a === "--yes") {
      /* non-interactive already */
    } else if (a === "--set") opts.setVersion = args[++i] ?? null;
    else if (a.startsWith("--set=")) opts.setVersion = a.slice("--set=".length);
    else if (a === "--from") opts.fromRef = args[++i] ?? null;
    else if (a.startsWith("--from=")) opts.fromRef = a.slice("--from=".length);
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
        "[release] usage: release.ts <patch|minor|major> [--set X.Y.Z] [--from <ref>] [--dry-run] [--install-links] [--no-notes|--no-git|--no-vercel|--no-npm]",
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
    const history = collectHistory(next, opts.fromRef);
    console.log(kleur.dim(`    history range: ${history.fromRef}..HEAD`));
    notes = await generateNotes(history);
    if (!opts.dryRun) {
      const written = writeNotes(next, notes, install);
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

  // ── Git commit + tag ──
  if (opts.git && !opts.dryRun) {
    console.log(kleur.bold("\n  Git:"));
    git(["add", "-A"]);
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

  // ── Vercel PLATFORM_VERSION sync ──
  if (opts.vercel) {
    console.log(kleur.bold("\n  Vercel PLATFORM_VERSION sync:"));
    if (opts.dryRun) {
      const cfg = vercelCfg();
      if (cfg) {
        const projects = await listV2Projects(cfg);
        for (const p of projects)
          console.log(
            kleur.dim(`    would set ${p.name} → ${next} (dev+preview+prod)`),
          );
      }
    } else {
      await syncVercel(next);
    }
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

main().catch((err) => {
  console.error(
    kleur.red(err instanceof Error ? (err.stack ?? err.message) : String(err)),
  );
  exit(1);
});
