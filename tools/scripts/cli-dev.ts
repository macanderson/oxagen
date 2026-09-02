#!/usr/bin/env tsx
/**
 * cli-dev — make `oxagen` on this machine ALWAYS mean "this monorepo's CLI,
 * straight from source, latest".
 *
 * What it does, every run:
 *   1. Removes every OTHER `oxagen` on the machine — global npm/pnpm installs,
 *      stale launchers, and copies in other repos' `node_modules/.bin` — so a
 *      published/older build can never shadow the working tree.
 *   2. (Re)installs a tiny shell launcher that execs the repo-local `tsx`
 *      against `apps/cli/src/index.tsx`. No build, no watch, no `dist`: every
 *      invocation runs the current source, so you always get the latest version.
 *
 * Why a launcher, not a symlink to `dist/index.js`: the CLI imports workspace
 * packages published as raw TypeScript (`exports` → `./src/index.ts`), so the
 * built `dist` can't run under plain `node`, and its `tsx` shebang only works if
 * `tsx` is on the global PATH (it isn't — it's a workspace dev-dependency). The
 * launcher sidesteps both by invoking the repo's own `tsx`, and preserves the
 * caller's cwd so `oxagen` operates on the directory you run it from.
 *
 * Usage:
 *   pnpm cli:dev          # sweep external installs + install `oxagen` from source
 *   pnpm cli:install      # alias (kept for backwards compatibility)
 */
import kleur from "kleur";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  BIN_NAME,
  buildLauncherScript,
  classifyBin,
  firstBinOnPath,
  hasGlobalPkg,
  parsePathEntries,
  pickInstallDir,
  uniqueDirs,
} from "./lib/cli-dev";

const ROOT = resolve(process.cwd());
const SRC_ENTRY = resolve(ROOT, "apps/cli/src/index.tsx");
const TSX_BIN = resolve(ROOT, "node_modules/.bin/tsx");
const LOCAL_BIN = resolve(homedir(), ".local/bin");

/** Run a command and return trimmed stdout, or null if it fails / isn't installed. */
function tryExecFile(cmd: string, args: string[]): string | null {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Read a file's contents, or null if it can't be read (broken symlink, perms). */
function readSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Probe whether we can create files in `dir` (creating it if needed). */
function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.oxagen-cli-dev-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Does a filesystem entry (file, symlink, even broken) exist at `p`? */
function entryExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort `pnpm remove -g` / `npm uninstall -g` of a global `@oxagen/cli` package. */
function uninstallGlobalPackages(): void {
  const pnpmRoot = tryExecFile("pnpm", ["root", "-g"]);
  if (hasGlobalPkg(pnpmRoot, existsSync)) {
    console.log(
      kleur.dim(`[cli:dev] removing global pnpm package @oxagen/cli …`),
    );
    tryExecFile("pnpm", ["remove", "-g", "@oxagen/cli"]);
  }

  const npmRoot = tryExecFile("npm", ["root", "-g"]);
  if (hasGlobalPkg(npmRoot, existsSync)) {
    console.log(
      kleur.dim(`[cli:dev] removing global npm package @oxagen/cli …`),
    );
    tryExecFile("npm", ["uninstall", "-g", "@oxagen/cli"]);
  }
}

/**
 * Every directory that could hold an `oxagen` executable: each $PATH entry plus
 * the package managers' global bin dirs (in case they aren't on $PATH).
 */
function candidateBinDirs(pathEntries: string[]): string[] {
  const pnpmBin = tryExecFile("pnpm", ["bin", "-g"]);
  const npmPrefix = tryExecFile("npm", ["prefix", "-g"]);
  const npmBin = npmPrefix ? join(npmPrefix, "bin") : null;
  return uniqueDirs([...pathEntries, pnpmBin, npmBin, LOCAL_BIN]);
}

/** Find every existing `oxagen` executable across the candidate directories. */
function findOxagenBins(dirs: string[]): string[] {
  return dirs.map((dir) => join(dir, BIN_NAME)).filter(entryExists);
}

function main(): void {
  if (!existsSync(TSX_BIN)) {
    console.error(
      kleur.red(
        `[cli:dev] repo tsx not found at ${TSX_BIN} — run \`pnpm install\` first.`,
      ),
    );
    process.exit(1);
  }
  if (!existsSync(SRC_ENTRY)) {
    console.error(
      kleur.red(
        `[cli:dev] CLI source not found at ${SRC_ENTRY} — are you in the monorepo root?`,
      ),
    );
    process.exit(1);
  }

  // 1. Remove any externally-installed `oxagen` so the source build always wins.
  uninstallGlobalPackages();

  const pathEntries = parsePathEntries(process.env.PATH);
  const existing = findOxagenBins(candidateBinDirs(pathEntries));
  const failedRemovals: string[] = [];

  for (const binPath of existing) {
    const kind = classifyBin(readSafe(binPath), SRC_ENTRY);
    try {
      rmSync(binPath, { force: true });
      const label =
        kind === "dev-launcher"
          ? "previous dev launcher"
          : "external/global install";
      console.log(kleur.dim(`[cli:dev] removed ${label}: ${binPath}`));
    } catch {
      failedRemovals.push(binPath);
    }
  }

  // 2. (Re)install the launcher into a writable dir on $PATH (prefer ~/.local/bin).
  const { dir: installDir, onPath } = pickInstallDir({
    localBin: LOCAL_BIN,
    pathEntries,
    isWritable,
  });
  const linkPath = join(installDir, BIN_NAME);
  writeFileSync(linkPath, buildLauncherScript(TSX_BIN, SRC_ENTRY), "utf8");
  chmodSync(linkPath, 0o755);

  console.log(
    kleur.green(`[cli:dev] installed ${kleur.bold(BIN_NAME)} → ${linkPath}`),
  );
  console.log(
    kleur.dim(
      `[cli:dev]   ↳ runs ${SRC_ENTRY} via tsx (live source, always latest)`,
    ),
  );

  // 3. Warn about anything that still shadows us or keeps us off PATH.
  if (failedRemovals.length > 0) {
    console.log("");
    console.log(
      kleur.yellow(
        `[cli:dev] ⚠ could not remove ${failedRemovals.length} other \`${BIN_NAME}\`(s) (no write permission):`,
      ),
    );
    for (const p of failedRemovals)
      console.log(
        kleur.yellow(`[cli:dev]     ${p}  (remove manually: sudo rm '${p}')`),
      );
  }

  if (!onPath) {
    console.log("");
    console.log(
      kleur.yellow(
        `[cli:dev] ⚠ ${installDir} is not on your PATH — \`${BIN_NAME}\` won't resolve yet.`,
      ),
    );
    console.log(kleur.yellow(`[cli:dev]   Add it to your shell profile:`));
    console.log(
      kleur.yellow(`[cli:dev]     export PATH="${installDir}:$PATH"`),
    );
  }

  // Confirm the launcher we just wrote is the one a shell will actually resolve.
  const winner = firstBinOnPath(pathEntries, BIN_NAME, entryExists);
  if (winner && resolve(winner) !== resolve(linkPath)) {
    console.log("");
    console.log(
      kleur.yellow(
        `[cli:dev] ⚠ another \`${BIN_NAME}\` at ${winner} still shadows the dev launcher on your PATH.`,
      ),
    );
  }

  console.log(
    kleur.dim(
      `[cli:dev] verify with:  ${BIN_NAME} --version  &&  ${BIN_NAME} --help`,
    ),
  );
}

main();
