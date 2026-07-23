/**
 * oxagen-project-paths.ts — The single source of truth for where a
 * project-scoped `.oxagen/<kind>` directory lives, given a project root.
 *
 * Before this module existed, `agents/loader.ts` + `agents/write.ts` and
 * `slash/loader.ts` + `slash/write.ts` each independently inlined
 * `join(cwd, ".oxagen", "agents")` / `join(cwd, ".oxagen", "commands")`.
 * Two independent call sites computing the same path is exactly the shape
 * of bug that lets a loader and its scaffolder silently drift apart the
 * next time either one is edited — a scaffolded file becomes unreadable
 * (or vice versa) with no compiler error to catch it. Routing both the
 * read side and the write side through one function makes that class of
 * drift impossible: there is now exactly one place that knows the layout.
 */
import { join } from "node:path";

/** The project-scoped artifact kinds that live under `<projectRoot>/.oxagen/<kind>`. */
export type OxagenProjectKind = "agents" | "commands";

/**
 * Resolve `<projectRoot>/.oxagen/<kind>` — the canonical project-scope
 * directory for agents/commands. `projectRoot` defaults to `process.cwd()`.
 */
export function oxagenProjectDir(
  kind: OxagenProjectKind,
  projectRoot: string = process.cwd(),
): string {
  return join(projectRoot, ".oxagen", kind);
}
