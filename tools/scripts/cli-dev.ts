#!/usr/bin/env tsx
/**
 * cli-dev — build the `@oxagen/cli` package, install its `oxagen` binary onto
 * the developer's PATH, and (by default) keep rebuilding on source changes so
 * the on-PATH binary always reflects the working tree.
 *
 * How the "auto-reinstall on change" works without re-copying on every edit:
 * the binary is a *symlink* into the package's `dist/index.js`, and `tsc`
 * rewrites `dist/` in place. A symlink always resolves to the current contents
 * of its target, and `tsc`'s in-place overwrite preserves the file's exec bit,
 * so a single one-time symlink + chmod is enough — every incremental rebuild is
 * immediately live under `oxagen` with zero extra install work.
 *
 * Usage:
 *   pnpm cli:dev          # build, install to PATH, then watch + rebuild (Ctrl-C to stop)
 *   pnpm cli:dev --once   # build + install once and exit (no watcher)
 */
import { execa } from "execa";
import kleur from "kleur";
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(process.cwd());
const CLI_DIR = resolve(ROOT, "apps/cli");
const DIST_ENTRY = resolve(CLI_DIR, "dist/index.js");
const BIN_NAME = "oxagen";
const ONCE = process.argv.includes("--once");

/** Directories on $PATH, in priority order, that we're willing to install into. */
function pathEntries(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((p) => resolve(p));
}

/**
 * Pick a writable bin directory that is already on the developer's PATH.
 * Preference order: ~/.local/bin (XDG-ish, almost always on PATH), then the
 * pnpm global bin, then the first writable PATH entry. We deliberately do NOT
 * fall back to a dir that isn't on PATH — a binary you can't invoke is worse
 * than a clear error telling you how to fix your PATH.
 */
function resolveInstallDir(): { dir: string; onPath: boolean } {
  const onPath = new Set(pathEntries());
  const localBin = resolve(homedir(), ".local/bin");
  const preferred = [localBin, ...[...onPath]];

  for (const dir of preferred) {
    if (!onPath.has(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      // Probe writability without leaving a turd behind.
      const probe = join(dir, `.oxagen-cli-dev-probe-${process.pid}`);
      symlinkSync(DIST_ENTRY, probe);
      rmSync(probe);
      return { dir, onPath: true };
    } catch {
      // not writable / not creatable — try the next candidate
    }
  }

  // Nothing on PATH is writable. Fall back to ~/.local/bin and warn loudly.
  mkdirSync(localBin, { recursive: true });
  return { dir: localBin, onPath: false };
}

/** Create or refresh the `oxagen` symlink so it points at the freshly-built dist entry. */
function installSymlink(installDir: string): string {
  const linkPath = join(installDir, BIN_NAME);

  // Replace only if it's missing or doesn't already point where we want.
  let needsLink = true;
  if (existsSync(linkPath) || isSymlink(linkPath)) {
    try {
      if (isSymlink(linkPath) && resolve(dirname(linkPath), readlinkSync(linkPath)) === DIST_ENTRY) {
        needsLink = false;
      } else {
        rmSync(linkPath);
      }
    } catch {
      rmSync(linkPath, { force: true });
    }
  }
  if (needsLink) symlinkSync(DIST_ENTRY, linkPath);

  chmodSync(DIST_ENTRY, 0o755);
  return linkPath;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

async function buildOnce(): Promise<void> {
  console.log(kleur.cyan("[cli:dev] building @oxagen/cli (tsc)…"));
  await execa("pnpm", ["--filter", "@oxagen/cli", "build"], { stdio: "inherit", cwd: ROOT });
}

async function main(): Promise<void> {
  await buildOnce();

  if (!existsSync(DIST_ENTRY)) {
    console.error(kleur.red(`[cli:dev] expected build output missing: ${DIST_ENTRY}`));
    process.exit(1);
  }

  const { dir, onPath } = resolveInstallDir();
  const linkPath = installSymlink(dir);

  console.log(kleur.green(`[cli:dev] installed ${kleur.bold(BIN_NAME)} → ${linkPath}`));
  console.log(kleur.dim(`[cli:dev]   ↳ symlink to ${DIST_ENTRY}`));

  if (!onPath) {
    console.log("");
    console.log(kleur.yellow(`[cli:dev] ⚠ ${dir} is not on your PATH — \`${BIN_NAME}\` won't resolve yet.`));
    console.log(kleur.yellow(`[cli:dev]   Add it to your shell profile:`));
    console.log(kleur.yellow(`[cli:dev]     export PATH="${dir}:$PATH"`));
    console.log("");
  }

  console.log(kleur.dim(`[cli:dev] verify with:  ${BIN_NAME} --help`));

  if (ONCE) {
    console.log(kleur.green("[cli:dev] one-shot install complete."));
    return;
  }

  console.log(kleur.cyan("[cli:dev] watching for changes (Ctrl-C to stop)…"));
  // `tsc --watch` rebuilds dist/ in place on every save; the symlink stays live.
  const watcher = execa("pnpm", ["--filter", "@oxagen/cli", "exec", "tsc", "--watch", "--preserveWatchOutput"], {
    stdio: "inherit",
    cwd: ROOT,
  });

  const stop = (signal: NodeJS.Signals) => {
    watcher.kill(signal);
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await watcher;
}

main().catch((err: unknown) => {
  console.error(kleur.red(`[cli:dev] ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
