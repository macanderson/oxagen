/**
 * Per-project workspace binding, stored at <root>/.oxagen/workspace.json,
 * where <root> is the git top level when the project is a repository (see
 * `projectRootFor` in lib/working-copy.ts).
 *
 * Links the current project to a specific Oxagen org + workspace so that
 * `oxagen init` and downstream commands can resolve the right tenant without
 * requiring the global config (~/.config/oxagen/config.json) to carry the
 * workspace slug every time.
 *
 * This file must NOT import from api.ts or any module that imports api.ts —
 * api.ts imports this file to resolve scope, and a circular import would
 * silently break both modules.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface WorkspaceLink {
  orgSlug: string;
  /**
   * The org's database id, which `oxagen init` writes, or its public id
   * (`org_…`), which the Organization page shows for copying. Read only to
   * find the org again after a rename; either form works.
   */
  orgId: string;
  orgName: string;
  workspaceSlug: string;
  /** The workspace's database id or its public id (`wrk_…`). As `orgId`. */
  workspaceId: string;
  workspaceName: string;
  /** GitHub (or other VCS) repos this workspace is linked to. */
  repos?: Array<{ provider: "github"; fullName: string }>;
  linkedAt: string;
  /**
   * What the last `oxagen pull` wrote into `.oxagen/`. Absent before the first
   * pull, and in every link written before pull existed.
   */
  pull?: WorkspaceLinkPull;
}

/**
 * The base `oxagen pull` compares against: the published commit it wrote and
 * the sha256 of every file as written. A local file whose hash still matches
 * its entry was not edited here, so the next pull may replace or delete it.
 */
export interface WorkspaceLinkPull {
  /** The production branch head the files were read at. */
  commit: string;
  /** The repository binding (`rpb_…`) the files came from. */
  bindingId: string;
  /** `owner/name` of that repository. */
  fullName: string;
  pulledAt: string;
  /** Project-relative path (always under `.oxagen/`) to the sha256 hex of its bytes. */
  files: Record<string, string>;
}

/** Absolute path to the workspace link file for the given project root. */
export function workspaceLinkPath(cwd: string): string {
  return join(cwd, ".oxagen", "workspace.json");
}

/**
 * Read the workspace link for the given project root.
 * Returns null when the file is absent or contains invalid JSON — never throws.
 * Emits a warning to stderr when the file is present but corrupt.
 */
export function readWorkspaceLink(cwd: string): WorkspaceLink | null {
  const filePath = workspaceLinkPath(cwd);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as WorkspaceLink;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Warning: corrupt workspace link at ${filePath}: ${detail}\n`,
    );
    return null;
  }
}

/** Write (or overwrite) the workspace link for the given project root. */
export function writeWorkspaceLink(cwd: string, link: WorkspaceLink): void {
  const dir = join(cwd, ".oxagen");
  mkdirSync(dir, { recursive: true });
  writeFileSync(workspaceLinkPath(cwd), JSON.stringify(link, null, 2), "utf8");
}

/**
 * Remove the workspace link file if it exists.
 * Returns true when a file was deleted, false when there was nothing to delete.
 */
export function clearWorkspaceLink(cwd: string): boolean {
  const filePath = workspaceLinkPath(cwd);
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}
