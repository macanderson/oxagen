import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every directory whose `.env.local` is hydrated from Vercel, paired with the
 * Vercel project it must be linked to (`.vercel/project.json`). This is the
 * single source of truth shared by `pnpm env:pull` (which pulls into each
 * directory) and `pnpm dev` (which refuses to start until every file exists).
 *
 * Keeping one list matters: the two scripts used to carry separate copies and
 * `env-pull.ts` kept a target for `apps/website` for months after that app was
 * deleted in v0.3.0.
 *
 * The root and `apps/app` share one project; `apps/api` and `apps/mcp` each
 * have their own. `apps/api`'s dev script is `tsx watch --env-file=.env.local`,
 * so a missing per-app file is fatal deep inside turbo — `pnpm dev` checks up
 * front instead.
 */
export interface EnvTarget {
  /** Display name used in log lines. */
  readonly name: string;
  /** Directory relative to the repo root. `.` is the root itself. */
  readonly dir: string;
  /** Vercel project (scope `oxagen`) the directory must be linked to. */
  readonly project: string;
}

export const VERCEL_SCOPE = "oxagen";

export const ENV_TARGETS: ReadonlyArray<EnvTarget> = [
  { name: "root", dir: ".", project: "oxagen-v2-app" },
  { name: "@oxagen/app", dir: "apps/app", project: "oxagen-v2-app" },
  { name: "@oxagen/api", dir: "apps/api", project: "oxagen-v2-api" },
  { name: "@oxagen/mcp", dir: "apps/mcp", project: "oxagen-v2-mcp" },
];

/** Targets whose `.env.local` does not exist under `root`. */
export function missingEnvTargets(
  root: string,
  exists: (path: string) => boolean = existsSync,
  targets: ReadonlyArray<EnvTarget> = ENV_TARGETS,
): EnvTarget[] {
  return targets.filter((t) => !exists(resolve(root, t.dir, ".env.local")));
}

/**
 * Copy-pasteable shell lines that create the missing links. Each line is a
 * subshell so the caller's cwd is untouched.
 */
export function linkHint(targets: ReadonlyArray<EnvTarget>): string {
  return targets
    .map(
      (t) =>
        `  (cd ${t.dir} && vercel link --yes --project ${t.project} --scope ${VERCEL_SCOPE})`,
    )
    .join("\n");
}
