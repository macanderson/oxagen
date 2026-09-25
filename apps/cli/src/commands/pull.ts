/**
 * `oxagen pull`: write the steering published in this workspace into this
 * directory's `.oxagen/`.
 *
 * Steering is published by merging a Context PR onto the main repository's
 * production branch (ADR-061). A developer's machine may not have git access
 * to that repository, and a checkout of another repository has no branch to
 * sync from at all, so pull reads the published tree from Oxagen
 * (`get_published_steering`) and writes it here.
 *
 * Pull never silently overwrites work. It keeps a base in
 * `.oxagen/workspace.json` (`pull.files`: the sha256 of every file it wrote)
 * and decides each path three ways:
 *
 *   absent here                      create
 *   here == published                unchanged
 *   here == base (not edited here)   update
 *   anything else                    conflict (edited here)
 *
 * A file in the base that is no longer published is deleted when it was not
 * edited here, and is a conflict when it was. One conflict refuses the whole
 * pull and nothing is written, unless `--force`.
 *
 * Nothing is written outside `<root>/.oxagen/`. A published path that is not
 * under `.oxagen/`, that normalizes out of it, or that names the machine's own
 * `.oxagen/workspace.json` refuses the pull, `--force` or not. A local
 * symlink that would carry a write out of `.oxagen/` refuses it too.
 *
 * Output discipline (ADR-023 §4): `--json` prints the plan and result as one
 * line on stdout, and warnings go to stderr. Exit 0 on success or nothing to
 * do, 1 on a refusal or an API failure, 2 on bad arguments.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  posix,
  sep,
} from "node:path";
import { apiPostOrThrow } from "../lib/api.js";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";
import {
  reportWorkingCopy,
  type WorkingCopyOutcome,
} from "../lib/working-copy.js";
import {
  readWorkspaceLink,
  workspaceLinkPath,
  writeWorkspaceLink,
  type WorkspaceLink,
} from "./workspace-link.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** The `get_published_steering` output. */
export interface PublishedSteering {
  bindingId: string;
  role: string;
  fullName: string;
  productionBranch: string;
  head: string | null;
  files: Array<{ path: string; content: string }>;
  readAt: string;
}

export type PlanAction =
  | "create"
  | "update"
  | "delete"
  | "unchanged"
  | "conflict";

export interface PlanEntry {
  path: string;
  action: PlanAction;
  /** For a conflict: what the published side would do to the local edit. */
  wants?: "update" | "delete";
}

export interface PullPlan {
  /** Every path the pull considered, in path order. */
  entries: PlanEntry[];
  /** Paths edited here that the pull would overwrite or delete. */
  conflicts: string[];
  /** Published paths the pull refuses to write, with the reason. */
  rejected: Array<{ path: string; reason: string }>;
  /** Files to write, with their text. `--force` turns conflicts into writes. */
  writes: Array<{ path: string; content: string }>;
  /** Files to delete. `--force` turns conflicting deletes into deletes. */
  deletes: string[];
  /** The base to store after the pull: sha256 of every published file. */
  manifest: Record<string, string>;
}

/** Reads a project-relative path; null when it does not exist. */
export type LocalReader = (path: string) => string | Buffer | null;

// ── Paths ────────────────────────────────────────────────────────────────────

const OXAGEN_DIR = ".oxagen";
const LINK_PATH = `${OXAGEN_DIR}/workspace.json`;

/**
 * The canonical project-relative form of a published path, or the reason it
 * may not be written. Only paths inside `.oxagen/` pass, and never the link.
 */
export function checkSteeringPath(
  path: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, reason: "empty path" };
  }
  if (path.includes("\0")) return { ok: false, reason: "contains a NUL byte" };
  if (path.includes("\\")) {
    return { ok: false, reason: "contains a backslash" };
  }
  if (posix.isAbsolute(path) || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    return { ok: false, reason: "absolute path" };
  }
  const normalized = posix.normalize(path);
  if (
    normalized !== path ||
    normalized.split("/").some((s) => s === ".." || s === ".")
  ) {
    return { ok: false, reason: "not a canonical path" };
  }
  if (!normalized.startsWith(`${OXAGEN_DIR}/`)) {
    return { ok: false, reason: "outside .oxagen/" };
  }
  if (normalized === LINK_PATH) {
    return { ok: false, reason: "the machine's own workspace link" };
  }
  return { ok: true, path: normalized };
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

/** sha256 hex of a file's bytes. Text is hashed as UTF-8. */
export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Decide what a pull does to every path, with no filesystem access of its
 * own. `readLocal` answers for each path, `base` is the manifest the last
 * pull stored (empty or undefined before the first), and `force` turns every
 * conflict into the write or delete the published side asks for.
 */
export function planPull(input: {
  published: Array<{ path: string; content: string }>;
  readLocal: LocalReader;
  base?: Record<string, string>;
  force?: boolean;
}): PullPlan {
  const base = input.base ?? {};
  const force = input.force === true;
  const entries: PlanEntry[] = [];
  const conflicts: string[] = [];
  const rejected: PullPlan["rejected"] = [];
  const writes: PullPlan["writes"] = [];
  const deletes: string[] = [];
  const manifest: Record<string, string> = {};

  const published = new Map<string, string>();
  for (const file of input.published) {
    const checked = checkSteeringPath(file.path);
    if (!checked.ok) {
      rejected.push({ path: String(file.path), reason: checked.reason });
      continue;
    }
    if (published.has(checked.path)) {
      rejected.push({ path: checked.path, reason: "published twice" });
      continue;
    }
    published.set(checked.path, file.content);
  }

  for (const [path, content] of [...published].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const want = sha256(content);
    manifest[path] = want;
    const local = input.readLocal(path);
    if (local === null) {
      entries.push({ path, action: "create" });
      writes.push({ path, content });
      continue;
    }
    const have = sha256(local);
    if (have === want) {
      entries.push({ path, action: "unchanged" });
    } else if (base[path] === have || force) {
      // Not edited since the last pull wrote it, or --force.
      entries.push({ path, action: "update" });
      writes.push({ path, content });
    } else {
      entries.push({ path, action: "conflict", wants: "update" });
      conflicts.push(path);
    }
  }

  const gone = Object.keys(base)
    .filter((p) => !published.has(p))
    .sort();
  for (const path of gone) {
    // A base the pull itself wrote can only name safe paths, but the file
    // is readable by anyone who can edit it, so check again.
    if (!checkSteeringPath(path).ok) continue;
    const local = input.readLocal(path);
    if (local === null) continue;
    if (sha256(local) === base[path] || force) {
      entries.push({ path, action: "delete" });
      deletes.push(path);
    } else {
      entries.push({ path, action: "conflict", wants: "delete" });
      conflicts.push(path);
    }
  }

  // With --force the conflicts became writes and deletes above, so none stand.
  return {
    entries,
    conflicts: force ? [] : conflicts,
    rejected,
    writes,
    deletes,
    manifest,
  };
}

// ── Filesystem ───────────────────────────────────────────────────────────────

/**
 * Walk up from `start` to the nearest directory holding
 * `.oxagen/workspace.json`, or null when there is none.
 */
export function findLinkedRoot(start: string): string | null {
  let dir = start;
  const { root } = parsePath(start);
  for (;;) {
    try {
      if (lstatSync(workspaceLinkPath(dir)).isFile()) return dir;
    } catch {
      // Not here; keep walking.
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A reader over `<root>/<path>`. Anything but a regular file reads as present-and-different. */
export function fsReader(root: string): LocalReader {
  return (path) => {
    const abs = join(root, ...path.split("/"));
    try {
      const st = lstatSync(abs);
      // A symlink or a directory where a file is published is never a file
      // pull wrote, so it must not read as absent (create) or as equal.
      if (!st.isFile()) return Buffer.from(`\0not-a-file:${abs}`);
      return readFileSync(abs);
    } catch {
      return null;
    }
  };
}

/**
 * Throw unless writing or deleting `<root>/<path>` stays inside
 * `<root>/.oxagen/`: the target is not a symlink, and the deepest existing
 * ancestor resolves inside `.oxagen/`.
 */
function assertInsideOxagen(root: string, path: string): void {
  const oxagenAbs = join(root, OXAGEN_DIR);
  let oxagenReal: string;
  try {
    oxagenReal = realpathSync(oxagenAbs);
  } catch {
    // `.oxagen/` does not exist yet; writeWorkspaceLink created it for init,
    // so this only happens in a hand-made layout. Nothing below can escape.
    return;
  }
  const abs = join(root, ...path.split("/"));
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      throw new Error(
        `${path} is a symlink, and pull does not write through one`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let dir = dirname(abs);
  for (;;) {
    let real: string | null = null;
    try {
      real = realpathSync(dir);
    } catch {
      real = null;
    }
    if (real !== null) {
      if (real !== oxagenReal && !real.startsWith(oxagenReal + sep)) {
        throw new Error(`${path} resolves outside .oxagen/`);
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Remove now-empty directories from `path`'s parent up to, not including, `.oxagen/`. */
function pruneEmptyDirs(root: string, path: string): void {
  const stop = join(root, OXAGEN_DIR);
  let dir = dirname(join(root, ...path.split("/")));
  while (dir.startsWith(stop + sep)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/** Apply a plan's writes and deletes under `root`. Checks every target first. */
export function applyPlan(root: string, plan: PullPlan): void {
  for (const w of plan.writes) assertInsideOxagen(root, w.path);
  for (const d of plan.deletes) assertInsideOxagen(root, d);
  for (const w of plan.writes) {
    const abs = join(root, ...w.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    atomicWriteFileSync(abs, w.content);
  }
  for (const d of plan.deletes) {
    rmSync(join(root, ...d.split("/")), { force: true });
    pruneEmptyDirs(root, d);
  }
}

// ── Command ──────────────────────────────────────────────────────────────────

export interface PullOptions {
  binding?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const NOT_LINKED =
  "This directory is not linked to a workspace. Run `oxagen init --org <org> --workspace <workspace>` first.";

const BINDING_ID = /^rpb_[0-9A-Za-z]+$/;

function short(sha: string): string {
  return sha.slice(0, 7);
}

function files(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

export async function pull(
  opts: PullOptions = {},
  writer: CommandWriter = stdoutWriter,
  cwd: string = process.cwd(),
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);

  if (opts.binding !== undefined && !BINDING_ID.test(opts.binding)) {
    out.error(
      `--binding takes a repository binding id (rpb_…), not "${opts.binding}".`,
      "bad_argument",
    );
    process.exitCode = 2;
    return;
  }

  const root = findLinkedRoot(cwd);
  const link: WorkspaceLink | null = root ? readWorkspaceLink(root) : null;
  if (!root || !link?.orgSlug || !link.workspaceSlug) {
    out.error(NOT_LINKED, "not_linked");
    return;
  }
  const scope = { org: link.orgSlug, ws: link.workspaceSlug };

  let published: PublishedSteering;
  try {
    published = await apiPostOrThrow<PublishedSteering>(
      "context/steering/published",
      opts.binding ? { bindingId: opts.binding } : {},
      scope,
    );
  } catch (err) {
    out.error(err, "api_error");
    return;
  }

  const source = published.fullName;
  if (published.head === null) {
    out.error(
      `The production branch ${published.productionBranch} of ${source} is gone, so nothing is published to pull. Set the production branch on the Repositories page.`,
      "branch_gone",
    );
    return;
  }
  const head = published.head;
  const at = `${source}@${short(head)} (${published.productionBranch})`;

  const plan = planPull({
    published: published.files,
    readLocal: fsReader(root),
    base: link.pull?.files,
    force: opts.force,
  });

  const created = plan.entries
    .filter((e) => e.action === "create")
    .map((e) => e.path);
  const updated = plan.entries
    .filter((e) => e.action === "update")
    .map((e) => e.path);
  const deleted = plan.entries
    .filter((e) => e.action === "delete")
    .map((e) => e.path);
  const unchanged = plan.entries.filter((e) => e.action === "unchanged").length;
  const summary = {
    projectRoot: root,
    repository: published.fullName,
    bindingId: published.bindingId,
    productionBranch: published.productionBranch,
    head,
    created,
    updated,
    deleted,
    unchanged,
    conflicts: plan.conflicts,
    rejected: plan.rejected,
  };

  if (plan.rejected.length > 0) {
    const list = plan.rejected.map((r) => `${r.path} (${r.reason})`).join(", ");
    if (out.isJson) {
      out.data({ status: "refused", refusal: "unsafe_paths", ...summary });
    }
    out.error(
      `Refused: ${source} publishes paths pull will not write: ${list}. Nothing was written.`,
      "unsafe_paths",
    );
    return;
  }

  if (plan.conflicts.length > 0) {
    if (out.isJson) {
      out.data({ status: "refused", refusal: "conflicts", ...summary });
    } else {
      for (const path of plan.conflicts) writer.write(`conflict ${path}`);
    }
    out.error(
      `Refused: ${plan.conflicts.length} file${plan.conflicts.length === 1 ? " was" : "s were"} edited here and differ from ${at}. Nothing was written. Move your edits aside, or run \`oxagen pull --force\` to overwrite them.`,
      "conflicts",
    );
    return;
  }

  const changes = created.length + updated.length + deleted.length;

  if (opts.dryRun) {
    if (out.isJson) {
      out.data({ status: "dry_run", ...summary });
      return;
    }
    for (const p of created) writer.write(`would create ${p}`);
    for (const p of updated) writer.write(`would update ${p}`);
    for (const p of deleted) writer.write(`would delete ${p}`);
    writer.write(
      changes === 0
        ? `Dry run: already up to date with ${at}.`
        : `Dry run: would pull ${files(created.length + updated.length)} and delete ${deleted.length} from ${at}. Nothing was written.`,
    );
    return;
  }

  try {
    applyPlan(root, plan);
  } catch (err) {
    out.error(
      `Pull stopped: ${err instanceof Error ? err.message : String(err)}`,
      "write_failed",
    );
    return;
  }

  const current = readWorkspaceLink(root) ?? link;
  writeWorkspaceLink(root, {
    ...current,
    pull: {
      commit: head,
      bindingId: published.bindingId,
      fullName: published.fullName,
      pulledAt: new Date().toISOString(),
      files: plan.manifest,
    },
  });

  const workingCopy: WorkingCopyOutcome = await reportWorkingCopy({
    root,
    scope,
    event: "pull",
    pulledCommit: head,
  });
  if ("error" in workingCopy) {
    out.warn(
      `Warning: could not report this directory to Oxagen: ${workingCopy.error}`,
    );
  }

  if (out.isJson) {
    out.data({
      status: changes === 0 ? "up_to_date" : "pulled",
      ...summary,
      workingCopy,
    });
    return;
  }
  for (const p of created) writer.write(`created ${p}`);
  for (const p of updated) writer.write(`updated ${p}`);
  for (const p of deleted) writer.write(`deleted ${p}`);
  if (changes === 0) {
    writer.write(`Already up to date with ${at}.`);
    return;
  }
  const deletedNote = deleted.length > 0 ? `, deleted ${deleted.length}` : "";
  writer.write(
    `Pulled ${files(created.length + updated.length)} from ${at}${deletedNote}.`,
  );
}
