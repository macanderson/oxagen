#!/usr/bin/env tsx
/**
 * release.ts — lockstep version release for the whole monorepo.
 *
 * Every workspace package is versioned in lockstep (one number for the entire
 * platform), so a release is: bump every package.json `version` to the same new
 * value, regenerate AI-written release notes from the git history since the last
 * tag, commit + tag, and propagate the new platform version to Vercel as the
 * `PLATFORM_VERSION` env var across every oxagen-v2 project and every
 * environment (development / preview / production).
 *
 *   pnpm release:patch            # 0.1.0 -> 0.1.1
 *   pnpm release:minor            # 0.1.0 -> 0.2.0
 *   pnpm release:major            # 0.1.0 -> 1.0.0
 *   tsx tools/scripts/release.ts minor --dry-run     # show everything, write nothing
 *   tsx tools/scripts/release.ts --set 0.2.0         # set an exact version
 *
 * Flags:
 *   --dry-run     compute + print, but write no files, no git, no Vercel
 *   --set X.Y.Z   set an exact version instead of bumping
 *   --from <ref>  base ref for the notes diff (default: newest tag); use this to
 *                 regenerate notes for an already-tagged release
 *   --no-notes    skip the Anthropic release-notes generation (plain changelog)
 *   --no-git      skip the commit + tag
 *   --no-vercel   skip the Vercel PLATFORM_VERSION sync
 *   --yes         (reserved) non-interactive; this script is already non-interactive
 *
 * Release notes are AI-generated from the commit log + diffstat between the last
 * release tag and the release commit, 100% through the Vercel AI Gateway
 * (AI_GATEWAY_API_KEY, model = OXAGEN_LLM_BALANCED, an Anthropic Claude model).
 * If no gateway key is reachable it falls back to a plain commit-log changelog
 * so a release never blocks on AI availability. No SDK dependency.
 *
 * Vercel sync uses the REST API (VERCEL_TOKEN + VERCEL_TEAM_ID) because the
 * Vercel CLI can't set "all preview branches" non-interactively. PLATFORM_VERSION
 * is a plain (non-secret) tag.
 *
 * Run via `pnpm release:<patch|minor|major>` (wraps this with --env-file-if-exists).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { argv, env, exit } from "node:process";
import { join, resolve } from "node:path";
import kleur from "kleur";

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

// ── workspace discovery ──────────────────────────────────────────────────────

/** Resolve every workspace package.json from the pnpm-workspace.yaml globs + root. */
function workspacePackageFiles(): string[] {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split("\n")) {
    if (/^packages:/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*["']?([^"'\n]+?)["']?\s*$/.exec(raw);
      if (m && m[1]) globs.push(m[1]);
      else if (/^\S/.test(raw)) break; // next top-level key ends the list
    }
  }
  const files = new Set<string>([join(ROOT, "package.json")]);
  for (const glob of globs) {
    if (!glob.endsWith("/*")) continue; // only support the `dir/*` shape we use
    const dir = join(ROOT, glob.slice(0, -2));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkg = join(dir, name, "package.json");
      if (existsSync(pkg)) files.add(pkg);
    }
  }
  return [...files].sort();
}

/** Rewrite a package.json `version` field in place, preserving 2-space format. */
function setPackageVersion(
  file: string,
  version: string,
): { name: string; from: string } {
  const text = readFileSync(file, "utf8");
  const pkg = JSON.parse(text) as { name?: string; version?: string };
  const from = pkg.version ?? "(none)";
  // Replace only the top-level "version": "..." to avoid touching nested fields.
  const next = text.replace(
    /^(\s*)"version":\s*"[^"]*"/m,
    `$1"version": "${version}"`,
  );
  if (next === text && from !== version) {
    // No top-level version key — inject one after "name".
    const injected = text.replace(
      /^(\s*)"name":\s*"[^"]*",/m,
      `$1"name": ${JSON.stringify(pkg.name)},\n$1"version": "${version}",`,
    );
    writeFileSync(file, injected);
  } else {
    writeFileSync(file, next);
  }
  return { name: pkg.name ?? file, from };
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
    gitSafe(["log", range, "--no-merges", "--pretty=format:- %s (%h) — %an"]) ??
    "";
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

function fallbackNotes(h: NotesInput): string {
  const body = h.log.trim() || "- No commits since the last release.";
  return `## v${h.version}\n\n_Changes since ${h.fromRef}._\n\n${body}\n`;
}

function notesPrompt(h: NotesInput): string {
  return [
    `You are writing the release notes for version ${h.version} of the Oxagen platform`,
    `(a multi-tenant AI agent monorepo). Summarize what changed since the previous`,
    `release (${h.fromRef}).`,
    ``,
    `Write clear, user-facing Markdown release notes. Start with a one-paragraph`,
    `summary, then group the changes under "### Features", "### Fixes",`,
    `"### Internal" (omit any empty group). Be specific and concise; reference`,
    `commit short-hashes where useful. Do NOT invent changes that aren't supported`,
    `by the commits/diff. Do not include a top-level "# vX" heading — start at "##".`,
    ``,
    `## Commit log`,
    h.log || "(none)",
    ``,
    `## Diffstat`,
    h.stat || "(none)",
    ``,
    `## Unified diff (may be truncated)`,
    "```diff",
    h.diff || "(none)",
    "```",
  ].join("\n");
}

/** Vercel AI Gateway (AI_GATEWAY_API_KEY) — the platform's single AI path. Hits
 * an Anthropic Claude model (OXAGEN_LLM_BALANCED) via the gateway's
 * OpenAI-compatible endpoint. Returns null when no gateway key is configured. */
async function notesViaGateway(prompt: string): Promise<string | null> {
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
      messages: [{ role: "user", content: prompt }],
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

async function generateNotes(h: NotesInput): Promise<string> {
  const prompt = notesPrompt(h);
  // AI notes come 100% through the Vercel AI Gateway; a plain commit-log
  // changelog is the only fallback so a release never blocks on AI availability.
  try {
    const text = await notesViaGateway(prompt);
    if (text) {
      console.log(
        kleur.green("[release] release notes generated via AI Gateway."),
      );
      return `${text}\n`;
    }
    console.log(
      kleur.yellow(
        "[release] AI_GATEWAY_API_KEY not set — using plain commit-log notes.",
      ),
    );
  } catch (err) {
    console.log(
      kleur.yellow(
        `[release] AI Gateway failed (${err instanceof Error ? err.message : err}) — using plain commit-log notes.`,
      ),
    );
  }
  return fallbackNotes(h);
}

function writeNotes(
  version: string,
  notes: string,
): { changelog: string; release: string } {
  const releasesDir = join(ROOT, "releases");
  if (!existsSync(releasesDir)) execFileSync("mkdir", ["-p", releasesDir]);
  const releaseFile = join(releasesDir, `v${version}.md`);
  writeFileSync(
    releaseFile,
    `# v${version}\n\n${notes.replace(/^#+\s/, "## ").trimStart()}`,
  );

  const changelogFile = join(ROOT, "CHANGELOG.md");
  const prior = existsSync(changelogFile)
    ? readFileSync(changelogFile, "utf8")
    : "# Changelog\n";
  const header = prior.startsWith("# Changelog")
    ? "# Changelog\n"
    : "# Changelog\n";
  const rest = prior.replace(/^#\s*Changelog\s*\n?/, "");
  writeFileSync(
    changelogFile,
    `${header}\n${notes.trim()}\n\n${rest.trimStart()}`,
  );
  return { changelog: changelogFile, release: releaseFile };
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

// ── argument parsing ─────────────────────────────────────────────────────────

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
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "patch" || a === "minor" || a === "major") opts.bump = a;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-notes") opts.notes = false;
    else if (a === "--no-git") opts.git = false;
    else if (a === "--no-vercel") opts.vercel = false;
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
        "[release] usage: release.ts <patch|minor|major> [--set X.Y.Z] [--from <ref>] [--dry-run] [--no-notes|--no-git|--no-vercel]",
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

  const files = workspacePackageFiles();
  console.log(kleur.bold(`  Packages (${files.length}):`));
  for (const file of files) {
    if (opts.dryRun) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as {
        name?: string;
        version?: string;
      };
      console.log(
        `    ${kleur.dim(pkg.version ?? "?")} → ${kleur.green(next)}  ${pkg.name ?? file}`,
      );
    } else {
      const { name, from } = setPackageVersion(file, next);
      console.log(`    ${kleur.dim(from)} → ${kleur.green(next)}  ${name}`);
    }
  }
  if (!opts.dryRun) syncLocalEnv(next);

  // ── Release notes ──
  let notes = "";
  if (opts.notes) {
    console.log(kleur.bold("\n  Release notes:"));
    const history = collectHistory(next, opts.fromRef);
    console.log(kleur.dim(`    history range: ${history.fromRef}..HEAD`));
    notes = await generateNotes(history);
    if (!opts.dryRun) {
      const written = writeNotes(next, notes);
      console.log(
        kleur.green(
          `    ✓ ${written.release.replace(ROOT + "/", "")}  +  CHANGELOG.md`,
        ),
      );
    } else {
      console.log(
        kleur.dim(
          "\n" +
            notes
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
    const tagBody = notes.trim() || `Release v${next}`;
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
