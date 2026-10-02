import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every directory that gets a `.env.local`. `pnpm env:pull` writes all four
 * from SSM Parameter Store (ADR-240), and `pnpm dev` refuses to start until
 * every file exists. This is the one list both scripts read.
 *
 * Keeping one list matters: the two scripts used to carry separate copies and
 * `env-pull.ts` kept a target for `apps/website` for months after that app was
 * deleted in v0.3.0.
 *
 * `apps/api`'s dev script is `tsx watch --env-file=.env.local`, so a missing
 * per-app file is fatal deep inside turbo. `pnpm dev` checks up front instead.
 * The root target (`.`) is the only one that gets operator values.
 */
export interface EnvTarget {
  /** Display name used in log lines. */
  readonly name: string;
  /** Directory relative to the repo root. `.` is the root itself. */
  readonly dir: string;
}

export const ENV_TARGETS: ReadonlyArray<EnvTarget> = [
  { name: "root", dir: "." },
  { name: "@oxagen/app", dir: "apps/app" },
  { name: "@oxagen/api", dir: "apps/api" },
  { name: "@oxagen/mcp", dir: "apps/mcp" },
];

/** Targets whose `.env.local` does not exist under `root`. */
export function missingEnvTargets(
  root: string,
  exists: (path: string) => boolean = existsSync,
  targets: ReadonlyArray<EnvTarget> = ENV_TARGETS,
): EnvTarget[] {
  return targets.filter((t) => !exists(resolve(root, t.dir, ".env.local")));
}
