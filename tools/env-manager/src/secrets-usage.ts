// Derive which apps/packages consume a secret.
//
//  - APPS come from the registry: ENV_REGISTRY[key].services already lists the
//    deployable surfaces (api/app/mcp/website/admin/docs) that need each var.
//  - PACKAGES come from a single codebase scan: one ripgrep pass collects every
//    `process.env.FOO` / `env.FOO` reference, attributed to the owning top-level
//    apps/* or packages/* directory.
//
// Both are only *seeds* — the operator refines them inline in the UI afterward,
// and those edits are lock-protected against re-pulls.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ENV_REGISTRY } from "@oxagen/config";

/** The set of apps and packages available to tag a secret with, for the dropdown. */
export interface Workspace {
  /** apps/* directory names (e.g. "app", "api"), alpha-sorted. */
  apps: string[];
  /** packages/* directory names (e.g. "ai", "billing"), alpha-sorted. */
  packages: string[];
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Enumerate the workspace apps/packages (for the usage dropdown). */
export function listWorkspace(repoRoot: string): Workspace {
  return {
    apps: dirs(join(repoRoot, "apps")),
    packages: dirs(join(repoRoot, "packages")),
  };
}

/** A "usage" label, namespaced so apps and packages never collide in the column. */
export function appLabel(name: string): string {
  return `app:${name}`;
}
export function pkgLabel(name: string): string {
  return `pkg:${name}`;
}

// The single source of truth for env-var extraction, shared verbatim by BOTH
// the ripgrep fast path (`-e ENV_REF_PATTERN`) and the Node.js fallback
// (`new RegExp(ENV_REF_PATTERN, "g")`). Keeping ONE pattern string guarantees
// the two paths attribute references identically — a previous hand-translated
// JS literal silently dropped the `process.env["FOO"]` (bracket+quote) form,
// so CI (rg-absent → fallback) under-attributed packages vs. local (rg present).
//
// Matches `process.env.FOO`, `process.env["FOO"]` / `process.env['FOO']`, and
// `env.FOO`. The accessor is a single `[.\[]` character class (dot or open
// bracket) followed by an optional quote — NOT a `\.…|…\[…` alternation: the
// Rust regex engine ripgrep uses drops the bracket branch of such an
// alternation when it shares the `process.env` prefix with the dot branch
// (leftmost-first semantics), so quoted/bracket references silently go
// unattributed. The character class sidesteps that entirely.
const ENV_REF_PATTERN = String.raw`(?:process\.env|[^.\w]env)[.\[]["']?([A-Z][A-Z0-9_]{2,})`;
const ENV_REF_RE = new RegExp(ENV_REF_PATTERN, "g");

/**
 * Node.js-native fallback for `buildEnvRefIndex` — used when ripgrep is not
 * installed (e.g. CI). Walks the given search directories recursively and applies
 * the same regex the rg pass uses.
 *
 * Two known divergences from the rg pass, both of which can only ADD labels:
 * this walker has no binary-file detection (rg skips binaries; a stray match
 * inside a bundled asset is attributed here), and it does not honour
 * `.gitignore` beyond the hard-coded node_modules/dist/build/.next/coverage
 * skips. Usage is only ever a seed the operator refines, so an over-broad
 * label is a nuisance rather than a correctness bug.
 */
function walkRefIndex(
  repoRoot: string,
  searchDirs: string[],
  index: Map<string, Set<string>>,
): void {
  function walk(absDir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      // Never descend into dependency/build output trees. Without this the walk
      // reads every file under apps/<app>/node_modules (which still matches the
      // apps/ label filter below) — millions of files — and the env-check hangs.
      // This fallback only runs on hosts where `rg` is absent (e.g. CI), so the
      // bug never surfaced in the rg fast path used locally.
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === ".next" ||
        entry.name === "coverage"
      ) {
        continue;
      }
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        let content: string;
        try {
          content = readFileSync(absPath, "utf8");
        } catch {
          continue;
        }
        const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");
        const parts = relPath.split("/");
        let label: string | null = null;
        if (parts[0] === "apps" && parts[1]) label = appLabel(parts[1]);
        else if (parts[0] === "packages" && parts[1])
          label = pkgLabel(parts[1]);
        if (!label) continue;

        ENV_REF_RE.lastIndex = 0;
        for (
          let m = ENV_REF_RE.exec(content);
          m !== null;
          m = ENV_REF_RE.exec(content)
        ) {
          const token = m[1];
          if (!token) continue;
          const set = index.get(token) ?? new Set<string>();
          set.add(label);
          index.set(token, set);
        }
      }
    }
  }

  for (const dir of searchDirs) {
    walk(join(repoRoot, dir));
  }
}

/**
 * One ripgrep pass → a map of ENV_VAR → the apps/packages that reference it.
 * Matches `process.env.FOO`, `process.env["FOO"]`, and `env.FOO`. Attribution is
 * by the top-level directory (apps/<x> or packages/<x>) the file lives in.
 *
 * Falls back to a Node.js-native recursive walk when ripgrep is not available
 * (e.g. CI runners without rg installed), ensuring the test is hermetic and the
 * function works in any environment.
 */
export function buildEnvRefIndex(repoRoot: string): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const searchDirs = ["apps", "packages", "tools"];
  // -o: only matched text; --no-heading + --with-filename: `path:match` per line.
  // ENV_REF_PATTERN (module scope) is the single source of truth, shared with the
  // Node.js fallback below so the two paths attribute references identically.
  const pattern = ENV_REF_PATTERN;
  let out = "";
  let rgAvailable = true;
  try {
    out = execFileSync(
      "rg",
      [
        "--no-heading",
        "--with-filename",
        "-N",
        "-o",
        "-e",
        pattern,
        ...searchDirs,
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    // rg exits non-zero when there are zero matches; treat stdout (if any) as result.
    const err = e as { stdout?: string; status?: number; code?: string };
    if (err.stdout) {
      out = err.stdout;
    } else if (err.code === "ENOENT") {
      // ripgrep not installed — fall back to the Node.js walker.
      rgAvailable = false;
    } else {
      return index;
    }
  }

  if (!rgAvailable) {
    walkRefIndex(repoRoot, searchDirs, index);
    return index;
  }

  for (const line of out.split("\n")) {
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const path = line.slice(0, sep);
    const match = line.slice(sep + 1);
    const token = /([A-Z][A-Z0-9_]{2,})/.exec(match)?.[1];
    if (!token) continue;

    const parts = path.split("/");
    let label: string | null = null;
    if (parts[0] === "apps" && parts[1]) label = appLabel(parts[1]);
    else if (parts[0] === "packages" && parts[1]) label = pkgLabel(parts[1]);
    if (!label) continue;

    const set = index.get(token) ?? new Set<string>();
    set.add(label);
    index.set(token, set);
  }
  return index;
}

/**
 * Seed usage for a secret: registry services (apps) ∪ grep-derived references
 * (apps + packages) for its reconciled env key, plus the NEXT_PUBLIC_ twin.
 */
export function deriveUsage(
  envKey: string | null,
  refIndex: Map<string, Set<string>>,
): string[] {
  const out = new Set<string>();

  if (envKey) {
    const meta = ENV_REGISTRY[envKey];
    if (meta) for (const svc of meta.services) out.add(appLabel(svc));

    for (const candidate of [envKey, `NEXT_PUBLIC_${envKey}`]) {
      const refs = refIndex.get(candidate);
      if (refs) for (const r of refs) out.add(r);
    }
  }

  return [...out].sort((a, b) => a.localeCompare(b));
}
