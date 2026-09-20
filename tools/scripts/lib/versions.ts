/**
 * Every manifest in the monorepo that carries the platform version, whatever
 * its language, and the one way to read or write them.
 *
 * The version is lockstep (ADR-005): the root `package.json` is the source of
 * truth, and every other manifest must say the same number. `pnpm release:*`
 * writes them all through `setAllVersions`; `pnpm check:versions` fails CI
 * through `versionDrift` when any of them disagree.
 *
 * Discovery is by `git ls-files`, so an untracked scratch manifest, a nested
 * worktree, or a `target/` directory never counts. Kinds handled:
 *
 *   package.json   the root and every pnpm workspace member
 *   Cargo.toml     any tracked crate with a `[package]` table
 *   Cargo.lock     the `[[package]]` entry of each such crate
 *   pyproject.toml any tracked `[project]` table (none today; handled so the
 *                  next language joins the lockstep without a new script)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ManifestKind =
  | "package.json"
  | "Cargo.toml"
  | "Cargo.lock"
  | "pyproject.toml";

export interface VersionManifest {
  /** Repo-relative path. */
  file: string;
  kind: ManifestKind;
  /** The package or crate name the manifest declares. */
  name: string;
}

export interface VersionReading extends VersionManifest {
  version: string | null;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

function tracked(root: string, patterns: string[]): string[] {
  // `git ls-files` with no pathspec lists the whole index, so an empty pattern
  // list has to mean nothing, not everything. Caller bug, not a valid query.
  if (patterns.length === 0) return [];
  // `:(glob)` makes `*` stop at a slash, so `apps/*/package.json` is the
  // workspace member's manifest and not a fixture two directories down.
  const specs = patterns.map((p) => `:(glob)${p}`);
  const out = execFileSync("git", ["ls-files", "-z", "--", ...specs], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p !== "");
}

/** The `dir/*` globs under `packages:` in pnpm-workspace.yaml. */
function workspaceGlobs(root: string): string[] {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split("\n")) {
    if (/^packages:/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s*-\s*["']?([^"'\n]+?)["']?\s*$/.exec(raw);
    if (m?.[1]) globs.push(m[1]);
    else if (/^\S/.test(raw)) break;
  }
  return globs;
}

function packageJsonName(root: string, file: string): string {
  const pkg = JSON.parse(readFileSync(join(root, file), "utf8")) as {
    name?: string;
  };
  return pkg.name ?? file;
}

/** `[package]` table's `name = "..."`, or null when the file is a workspace root only. */
function cargoPackageName(text: string): string | null {
  const table = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
  if (!table) return null;
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(table[1] ?? "");
  return name?.[1] ?? null;
}

/** Every manifest that must carry the lockstep version, in a stable order. */
export function discoverManifests(root: string): VersionManifest[] {
  const manifests: VersionManifest[] = [];

  // Only `dir/*` is understood. Anything else (an exact path, `packages/**`)
  // would be dropped by the filter below and silently leave those members out
  // of the gate, so it stops the run instead.
  const globs = workspaceGlobs(root);
  const unhandled = globs.filter((g) => !g.endsWith("/*"));
  if (unhandled.length > 0)
    throw new Error(
      `pnpm-workspace.yaml lists a package glob this script cannot map to manifests: ${unhandled.join(", ")}. Teach discoverManifests the shape or the members it covers leave the version gate.`,
    );
  const workspacePatterns = globs.map(
    (g) => `${g.slice(0, -2)}/*/package.json`,
  );
  for (const file of ["package.json", ...tracked(root, workspacePatterns)]) {
    manifests.push({
      file,
      kind: "package.json",
      name: packageJsonName(root, file),
    });
  }

  for (const file of tracked(root, ["Cargo.toml", "**/Cargo.toml"])) {
    const name = cargoPackageName(readFileSync(join(root, file), "utf8"));
    if (name === null) continue;
    manifests.push({ file, kind: "Cargo.toml", name });
    const lock = join(dirname(file), "Cargo.lock");
    if (existsSync(join(root, lock)))
      manifests.push({ file: lock, kind: "Cargo.lock", name });
  }

  for (const file of tracked(root, ["pyproject.toml", "**/pyproject.toml"])) {
    const text = readFileSync(join(root, file), "utf8");
    const name = /^\[project\]\s*$[\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(text);
    if (name?.[1])
      manifests.push({ file, kind: "pyproject.toml", name: name[1] });
  }

  return manifests;
}

// Each kind edits only the one line that names the version, so formatting,
// comments, and every other field survive the rewrite untouched.

function cargoLockEntry(name: string): RegExp {
  return new RegExp(
    `(^\\[\\[package\\]\\]\\s*\\nname = "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\nversion = ")([^"]*)(")`,
    "m",
  );
}

export function readManifestVersion(
  root: string,
  manifest: VersionManifest,
): string | null {
  const text = readFileSync(join(root, manifest.file), "utf8");
  switch (manifest.kind) {
    case "package.json": {
      const pkg = JSON.parse(text) as { version?: string };
      return pkg.version ?? null;
    }
    case "Cargo.toml": {
      const table = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
      const m = /^\s*version\s*=\s*"([^"]*)"/m.exec(table?.[1] ?? "");
      return m?.[1] ?? null;
    }
    case "Cargo.lock": {
      const m = cargoLockEntry(manifest.name).exec(text);
      return m?.[2] ?? null;
    }
    case "pyproject.toml": {
      const table = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
      const m = /^\s*version\s*=\s*"([^"]*)"/m.exec(table?.[1] ?? "");
      return m?.[1] ?? null;
    }
  }
}

/**
 * The manifest's text with `version` written into it, or the text unchanged
 * when it already says that. Throws when the version line cannot be found, so
 * `setAllVersions` can learn that before it writes anything.
 */
function rewriteManifest(
  manifest: VersionManifest,
  text: string,
  current: string | null,
  version: string,
): string {
  let next = text;
  switch (manifest.kind) {
    case "package.json": {
      if (current === null) {
        // No top-level version key: add one after "name". The blind
        // `"version":` replace below would otherwise hit the first one at any
        // depth (under `pnpm.overrides`, `volta`, a dependency pin) and
        // corrupt it while leaving the top level still unversioned.
        next = text.replace(
          /^(\s*)("name":\s*"[^"]*",)/m,
          `$1$2\n$1"version": "${version}",`,
        );
      } else {
        next = text.replace(
          /^(\s*)"version":\s*"[^"]*"/m,
          `$1"version": "${version}"`,
        );
      }
      // The version is one key of a document that has to stay parseable, and
      // the write is a text replace. Read it back the way every consumer will.
      const parsed = JSON.parse(next) as { version?: string };
      if (parsed.version !== version)
        throw new Error(
          `rewriting ${manifest.file} left its version at ${String(parsed.version)}, not ${version}`,
        );
      break;
    }
    case "Cargo.toml":
    case "pyproject.toml": {
      const header = manifest.kind === "Cargo.toml" ? "package" : "project";
      const table = new RegExp(
        `^\\[${header}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
        "m",
      );
      next = text.replace(table, (block) =>
        block.replace(/^(\s*version\s*=\s*")[^"]*(")/m, `$1${version}$2`),
      );
      break;
    }
    case "Cargo.lock": {
      next = text.replace(cargoLockEntry(manifest.name), `$1${version}$3`);
      break;
    }
  }
  if (next === text && current !== version)
    throw new Error(
      current === null
        ? `could not find the version line in ${manifest.file}`
        : `could not rewrite the version line in ${manifest.file} (it says ${current})`,
    );
  return next;
}

export function writeManifestVersion(
  root: string,
  manifest: VersionManifest,
  version: string,
): void {
  if (!SEMVER.test(version))
    throw new Error(`"${version}" is not a release version (X.Y.Z)`);
  const path = join(root, manifest.file);
  const text = readFileSync(path, "utf8");
  writeFileSync(
    path,
    rewriteManifest(
      manifest,
      text,
      readManifestVersion(root, manifest),
      version,
    ),
  );
}

export function readRootVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!pkg.version) throw new Error("root package.json has no version");
  return pkg.version;
}

/** Every manifest whose version is not the root's. Empty means in sync. */
export function versionDrift(root: string): {
  version: string;
  manifests: VersionReading[];
  drift: VersionReading[];
} {
  const version = readRootVersion(root);
  const manifests = discoverManifests(root).map((m) => ({
    ...m,
    version: readManifestVersion(root, m),
  }));
  return {
    version,
    manifests,
    drift: manifests.filter((m) => m.version !== version),
  };
}

/**
 * Write `version` into every manifest; returns what each one said before.
 *
 * Two phases. Every rewrite is computed and checked first, so a manifest this
 * script cannot edit stops the release with the tree untouched, rather than
 * half the repo bumped and half not.
 */
export function setAllVersions(
  root: string,
  version: string,
): Array<VersionReading & { from: string | null }> {
  if (!SEMVER.test(version))
    throw new Error(`"${version}" is not a release version (X.Y.Z)`);
  const planned = discoverManifests(root).map((manifest) => {
    const from = readManifestVersion(root, manifest);
    const path = join(root, manifest.file);
    return {
      manifest,
      from,
      path,
      text: rewriteManifest(
        manifest,
        readFileSync(path, "utf8"),
        from,
        version,
      ),
    };
  });
  for (const p of planned) writeFileSync(p.path, p.text);
  return planned.map((p) => ({ ...p.manifest, version, from: p.from }));
}
