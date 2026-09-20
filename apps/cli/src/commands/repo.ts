/**
 * `oxagen repo …` — the workspace's repositories (Mission Control spec §10.1;
 * ADR-099). A workspace has one main repository, bound when the workspace is
 * created, and any number of linked ones. This surface reads and changes the
 * linked set; the main repository is neither linked nor unlinked here.
 *
 *   oxagen repo list                    — every repository the workspace
 *                                         binds, main first (list_repositories)
 *   oxagen repo link <owner/name>       — link a repository the workspace's
 *                                         GitHub App installation reaches
 *                                         (link_repository)
 *   oxagen repo unlink <bindingId>      — remove a linked repository by the
 *                                         `rpb_…` id `repo list` shows
 *                                         (unlink_repository)
 *
 * Every call goes through the shared org-scoped API client in lib/api.ts:
 * `repositories` (GET), `repository/link` and `repository/unlink` (POST). The
 * caller never names a GitHub installation. The API takes it from the
 * workspace's GitHub connection.
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload
 * as one line on stdout; pretty mode prints a table (list) or one line (link,
 * unlink); failures are uniform stderr lines (exit 2 for a bad argument,
 * exit 1 for an API failure).
 */
import { apiGetOrThrow, apiPostOrThrow, printTable } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Output shapes (mirror the repository.* contract outputs) ─────────────────

export type RepositoryRole = "main" | "linked";

/** One row of `list_repositories`. */
export interface RepositoryRow {
  bindingId: string;
  role: RepositoryRole;
  owner: string;
  name: string;
  fullName: string;
  defaultRef: string;
  htmlUrl: string;
  boundAt: string;
  connectionLive: boolean;
}

/** The `list_repositories` output. */
export interface RepositoryListResult {
  repositories: RepositoryRow[];
}

/** The `link_repository` output. */
export interface RepositoryLinkResult {
  bindingId: string;
  connectionId: string;
  fullName: string;
  defaultRef: string;
  role: "linked";
  linkedAt: string;
}

/** The `unlink_repository` output. */
export interface RepositoryUnlinkResult {
  bindingId: string;
  fullName: string;
  unlinkedAt: string;
}

interface RepoOptions {
  json?: boolean;
}

function usage(writer: CommandWriter, message: string, line: string): void {
  writer.writeErr(`error: ${message}`);
  writer.writeErr(`usage: ${line}`);
  process.exitCode = 2;
}

/**
 * Split `owner/name` into its two parts. Exactly one slash, neither side
 * empty; the API applies GitHub's own spelling rules after that.
 */
export function parseRepositoryRef(
  ref: string,
): { owner: string; name: string } | null {
  const parts = ref.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (owner.length === 0 || name.length === 0) return null;
  return { owner, name };
}

const connectionState = (live: boolean): string => (live ? "live" : "retired");

// ── repo list ────────────────────────────────────────────────────────────────

export async function repoList(
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RepositoryListResult;
  try {
    result = await apiGetOrThrow<RepositoryListResult>("repositories");
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  if (result.repositories.length === 0) {
    writer.write(
      "No repositories are bound to this workspace. Bind a main repository in Oxagen, then link more with `oxagen repo link <owner/name>`.",
    );
    return;
  }
  printTable(
    ["ROLE", "REPOSITORY", "DEFAULT REF", "BINDING", "CONNECTION"],
    result.repositories.map((r) => [
      r.role,
      r.fullName,
      r.defaultRef,
      r.bindingId,
      connectionState(r.connectionLive),
    ]),
    writer,
  );
  const retired = result.repositories.filter((r) => !r.connectionLive);
  if (retired.length > 0) {
    writer.write("");
    writer.write(
      `${retired.length} of ${result.repositories.length} sit on a retired GitHub connection and do not resolve. Reconnect GitHub from the workspace's settings.`,
    );
  }
}

// ── repo link ────────────────────────────────────────────────────────────────

export async function repoLink(
  ref: string,
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const parsed = parseRepositoryRef(ref);
  if (!parsed) {
    return usage(
      writer,
      `expected <owner/name>, got ${JSON.stringify(ref)}`,
      "oxagen repo link <owner/name> [--json]",
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: RepositoryLinkResult;
  try {
    result = await apiPostOrThrow<RepositoryLinkResult>("repository/link", {
      provider: "github",
      owner: parsed.owner,
      name: parsed.name,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `linked ${result.fullName} · ${result.defaultRef} · ${result.bindingId}`,
  );
  writer.write(
    "Runs on this repository can cite it in a grant's resource_scope; unlink it with `oxagen repo unlink <bindingId>`.",
  );
}

// ── repo unlink ──────────────────────────────────────────────────────────────

export async function repoUnlink(
  bindingId: string,
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const id = bindingId.trim();
  if (id.length === 0) {
    return usage(
      writer,
      "a binding id is required",
      "oxagen repo unlink <bindingId> [--json]",
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: RepositoryUnlinkResult;
  try {
    result = await apiPostOrThrow<RepositoryUnlinkResult>("repository/unlink", {
      bindingId: id,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(`unlinked ${result.fullName} · ${result.bindingId}`);
  writer.write(
    "Its binding versions stay as evidence for the runs that cited them. Link it again to write the next version.",
  );
}
