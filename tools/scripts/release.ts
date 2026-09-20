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
 *                 regenerate notes for an already-tagged release
 *   --no-notes    skip the Anthropic release-notes generation (plain changelog)
 *   --no-git      skip the commit + tag
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

type Bump = "patch" | "minor" | "major";

interface Options {
  bump: Bump | null;
  setVersion: string | null;
  fromRef: string | null;
  dryRun: boolean;
  notes: boolean;
  git: boolean;
  npm: boolean;
  installLinks: boolean;
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

// ── npm CLI publish (only if NPM_TOKEN is available) ────────────────────────

function npmCfg(): { token: string } | null {
  const token = deQuote(env.NPM_TOKEN);
  if (!token) {
    console.log(
      kleur.dim("[release] NPM_TOKEN not set — skipping npm publish."),
    );
    return null;
  }
  return { token };
}

/**
 * Build the standalone, publishable CLI artifact under apps/cli/dist-standalone/:
 * a single self-contained `oxagen.mjs` (every @oxagen/* and npm dep inlined, runs
 * under plain `node`) plus a clean manifest with NO `workspace:*` deps. Publishing
 * apps/cli/package.json directly is BROKEN — its deps carry `@oxagen/*:
 * workspace:*` (unpublished, protocol leaks) and its bin shebang is `tsx`, so
 * `npm i -g @oxagen/cli` fails in a clean env. See apps/cli/scripts/bundle.mjs +
 * prepare-standalone-publish.mjs for the full why. Must run AFTER the version
 * bump: the CLI inlines apps/cli/package.json at bundle time, so the bumped
 * version is what gets baked into oxagen.mjs.
 */
function buildCliBundle(): void {
  console.log(kleur.dim("    bundling standalone CLI..."));
  try {
    execFileSync("pnpm", ["-C", "apps/cli", "publish:standalone"], {
      cwd: ROOT,
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`CLI bundle failed: ${formatError(err)}`);
  }
}

async function publishCliToNpm(version: string): Promise<void> {
  const cfg = npmCfg();
  if (!cfg) return;

  try {
    console.log(kleur.bold("\n  npm CLI publish:"));
    // Build the standalone single-file bundle + clean publish manifest.
    buildCliBundle();
    console.log(kleur.green("    ✓ standalone CLI bundle built"));

    // Validate the generated publish manifest (NOT apps/cli/package.json, which
    // is unpublishable). Guard against the historical failure modes: private,
    // missing bin, version drift, and leaked workspace:* deps.
    const distDir = join(ROOT, "apps/cli/dist-standalone");
    const manifest = JSON.parse(
      readFileSync(join(distDir, "package.json"), "utf8"),
    ) as {
      name?: string;
      version?: string;
      private?: boolean;
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    if (manifest.private)
      throw new Error('CLI manifest has "private": true — cannot publish');
    if (!manifest.bin || Object.keys(manifest.bin).length === 0)
      throw new Error("CLI manifest missing bin field");
    if (manifest.version !== version)
      throw new Error(
        `CLI manifest version ${manifest.version} != release version ${version}`,
      );
    const leaked = Object.entries(manifest.dependencies ?? {}).filter(([, v]) =>
      v.startsWith("workspace:"),
    );
    if (leaked.length)
      throw new Error(
        `workspace:* deps leaked into publish manifest: ${leaked.map(([k]) => k).join(", ")}`,
      );

    // npm reads the auth token from .npmrc; write one that pulls NPM_TOKEN from
    // the environment. Never published — not in the manifest `files`, and npm
    // always excludes .npmrc from the tarball.
    writeFileSync(
      join(distDir, ".npmrc"),
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    );

    // Publish the bundle. access:public lives in the manifest publishConfig.
    console.log(kleur.dim("    publishing to npm registry..."));
    execFileSync("npm", ["publish"], {
      cwd: distDir,
      stdio: "pipe",
      env: { ...env, NPM_TOKEN: cfg.token },
      maxBuffer: 64 * 1024 * 1024,
    });

    console.log(kleur.green(`    ✓ @oxagen/cli v${version} published to npm`));
  } catch (err) {
    throw new Error(
      `npm publish failed: ${formatError(err)}. ` +
        `Ensure NPM_TOKEN is set and the CLI package is not marked as private.`,
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
        "[release] usage: release.ts <patch|minor|major> [--set X.Y.Z] [--from <ref>] [--dry-run] [--no-notes|--no-git|--no-npm]",
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
