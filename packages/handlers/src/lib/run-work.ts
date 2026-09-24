import { createHash } from "node:crypto";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { chSelect } from "@oxagen/telemetry";
import type {
  RunCapturedDiff,
  RunCheckout,
  RunRepository,
  RunSubagent,
} from "@oxagen/oxagen/contracts/run.work.get";
import type { RunScope } from "../run.list";

export interface ConnectedRunRepository extends RunRepository {
  connectionId: string;
  providerRepositoryId?: string;
}
export interface WorkContextRow {
  path: string;
  branch: string;
  head: string;
  remote: string;
  repository: string;
  first_seq: number | string;
  last_seq: number | string;
}
export interface WorkDiffRow extends WorkContextRow {
  seq: number | string;
  ts: string;
  base: string;
  content_digest: string;
  bytes_ref: string;
  complete: string;
  limitations: string;
  omitted: string;
}
export interface WorkSubagentRow {
  id: string;
  type: string;
  first_seq: number | string;
  last_seq: number | string;
  stopped: number | string;
}
export interface WorkPrLinkRow {
  url: string;
  number: string;
  repository: string;
  seq: number | string;
  ts: string;
}
export const WORK_CONTEXT_CAP = 200;
export const WORK_PR_LINK_CAP = 50;
export const WORK_SUBAGENT_CAP = 200;
export const WORK_DIFF_CAP = 200;
export const workDigest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const nullable = (value: string) => (value.length ? value : null);

export async function connectedRunRepositories(
  scope: RunScope,
): Promise<ConnectedRunRepository[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        connectionId: schema.repositoryBindings.connectionId,
        providerRepositoryId: schema.repositoryBindings.providerRepositoryId,
        owner: schema.repositoryBindings.providerOwner,
        name: schema.repositoryBindings.providerName,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .innerJoin(
        schema.sourceConnections,
        eq(schema.sourceConnections.id, schema.repositoryBindings.connectionId),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          eq(schema.repositoryBindings.orgId, scope.orgId),
          eq(schema.repositoryBindings.workspaceId, scope.workspaceId),
          eq(schema.sourceConnections.orgId, scope.orgId),
          eq(schema.sourceConnections.workspaceId, scope.workspaceId),
          eq(schema.repositoryBindings.provider, "github"),
          eq(schema.sourceConnections.status, "connected"),
          isNull(schema.sourceConnections.deletedAt),
        ),
      ),
  );
  return rows.map((row) => ({
    ...row,
    host: "github.com",
    url: `https://github.com/${row.owner}/${row.name}`,
    connected: true,
  }));
}

const PATH =
  "coalesce(nullIf(worktree_path, ''), nullIf(project_dir, ''), cwd)";
export async function readWorkContexts(
  sessionUuid: string,
): Promise<WorkContextRow[]> {
  const result = await chSelect<WorkContextRow>({
    query: `SELECT ${PATH} AS path, git_branch AS branch, git_remote_digest AS remote,
      argMax(git_head_sha, seq) AS head,
      argMaxIf(attrs['repository_url'], seq, attrs['repository_url'] != '') AS repository,
      min(seq) AS first_seq, max(seq) AS last_seq
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID} AND chain_verified = true
        AND ${PATH} != ''
      GROUP BY path, branch, remote ORDER BY first_seq ASC LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit: WORK_CONTEXT_CAP + 1 },
  });
  return result.data;
}
/**
 * The subagents a session started, one row per `hook.agent_id`, from the
 * `subagent_start` and `subagent_stop` hook frames. An in-process subagent
 * shares its parent's session, so these frames are the only record of it.
 */
export async function readWorkSubagents(
  sessionUuid: string,
): Promise<WorkSubagentRow[]> {
  const result = await chSelect<WorkSubagentRow>({
    query: `SELECT attrs['hook.agent_id'] AS id,
      argMaxIf(attrs['hook.agent_type'], seq, attrs['hook.agent_type'] != '') AS type,
      min(seq) AS first_seq, max(seq) AS last_seq,
      max(kind = 'subagent_stop') AS stopped
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID} AND chain_verified = true
        AND kind IN ('subagent_start', 'subagent_stop')
        AND attrs['hook.agent_id'] != ''
      GROUP BY id ORDER BY first_seq ASC LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit: WORK_SUBAGENT_CAP + 1 },
  });
  return result.data;
}
/**
 * The pull requests the harness said this session opened or linked, one row
 * per URL, from `oxagen:pr_link` frames. Claude Code writes one each time a
 * session creates or links a PR, so the link is certain and needs no branch
 * match. The earliest frame names where the run produced it.
 */
export async function readWorkPrLinks(
  sessionUuid: string,
): Promise<WorkPrLinkRow[]> {
  const result = await chSelect<WorkPrLinkRow>({
    query: `SELECT attrs['pr_url'] AS url,
      argMin(attrs['pr_number'], seq) AS number,
      argMaxIf(attrs['pr_repository'], seq, attrs['pr_repository'] != '') AS repository,
      min(seq) AS seq, toString(argMin(ts, seq)) AS ts
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID} AND chain_verified = true
        AND kind = 'oxagen:pr_link' AND attrs['pr_url'] != ''
      GROUP BY url ORDER BY seq ASC LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit: WORK_PR_LINK_CAP + 1 },
  });
  return result.data;
}
/**
 * A linked PR as `owner`, `name` and `number`. The frame's `pr_repository`
 * wins, and the URL's `/owner/name/pull/N` path fills what it leaves out.
 * Null when neither names a repository and a positive number.
 */
export function prLinkOf(
  row: Pick<WorkPrLinkRow, "url" | "number" | "repository">,
): { owner: string; name: string; number: number; url: string } | null {
  let path: string[] = [];
  try {
    const parsed = new URL(row.url);
    if (parsed.protocol !== "https:") return null;
    path = parsed.pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  const fromUrl = path.length >= 4 && path[2] === "pull" ? path : null;
  const [owner, name] = row.repository
    ? row.repository.split("/")
    : [fromUrl?.[0], fromUrl?.[1]];
  const number = Number(row.number || fromUrl?.[3]);
  if (
    !owner ||
    !name ||
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(name) ||
    !Number.isInteger(number) ||
    number <= 0
  )
    return null;
  return { owner, name, number, url: row.url };
}
/** The effort and thinking settings a wrapped session last recorded. */
export type SessionConfig = { effort: string | null; thinking: boolean | null };

/**
 * The session's effort and thinking settings. Effort is the latest
 * `effort_level_setting` from a session config frame, falling back to the
 * latest non-empty `effort` any frame carried. Thinking is the latest
 * `always_thinking_enabled`. Each is null when no frame recorded it.
 */
export async function readSessionConfig(
  sessionUuid: string,
): Promise<SessionConfig> {
  const result = await chSelect<{
    setting: string;
    effort: string;
    thinking: string;
  }>({
    query: `SELECT
        argMaxIf(effort_level_setting, seq, effort_level_setting != '') AS setting,
        argMaxIf(effort, seq, effort != '') AS effort,
        ifNull(toString(argMaxIf(always_thinking_enabled, seq,
          always_thinking_enabled IS NOT NULL)), '') AS thinking
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID} AND chain_verified = true`,
    params: { sessionUuid },
  });
  const row = result.data[0];
  return {
    effort: row?.setting.trim() || row?.effort.trim() || null,
    thinking:
      row?.thinking === "true"
        ? true
        : row?.thinking === "false"
          ? false
          : null,
  };
}

/**
 * The title the harness last gave the session, from its latest
 * `oxagen:session_title` frame. Claude Code renames a session as the work
 * takes shape, so the latest frame is the name the operator sees in the
 * harness. Null when the session recorded none.
 */
export async function readSessionTitle(
  sessionUuid: string,
): Promise<string | null> {
  const result = await chSelect<{ title: string }>({
    query: `SELECT JSONExtractString(body, 'session_title') AS title
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID} AND chain_verified = true
        AND kind = 'oxagen:session_title'
        AND JSONExtractString(body, 'session_title') != ''
      ORDER BY seq DESC LIMIT 1`,
    params: { sessionUuid },
  });
  return result.data[0]?.title.trim() || null;
}
export function subagentOf(row: WorkSubagentRow): RunSubagent {
  return {
    id: row.id,
    type: nullable(row.type),
    firstSeq: String(row.first_seq),
    lastSeq: String(row.last_seq),
    stopped: Number(row.stopped) === 1,
  };
}
export async function readWorkDiffs(
  sessionUuid: string,
): Promise<WorkDiffRow[]> {
  const result = await chSelect<WorkDiffRow>({
    query: `SELECT ${PATH} AS path, git_branch AS branch, git_remote_digest AS remote,
      attrs['diff_head_sha'] AS head, attrs['repository_url'] AS repository, seq, toString(ts) AS ts,
      attrs['diff_base_sha'] AS base, content_digest, bytes_ref,
      attrs['diff_complete'] AS complete, attrs['diff_limitations'] AS limitations,
      attrs['body_omitted'] AS omitted
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID} AND chain_verified = true
        AND kind = 'oxagen:worktree_reconciled'
      ORDER BY seq DESC LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit: WORK_DIFF_CAP + 1 },
  });
  return result.data;
}

export function checkoutId(
  row: Pick<WorkContextRow, "path" | "branch" | "remote">,
): string {
  return workDigest(JSON.stringify([row.path, row.branch, row.remote]));
}
export function recordedRepository(url: string): RunRepository | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parts.length !== 2 ||
      !parts.every((p) => /^[\w.-]+$/.test(p))
    )
      return null;
    return {
      host: parsed.hostname,
      owner: parts[0]!,
      name: parts[1]!,
      url: parsed.href.replace(/\/$/, ""),
      connected: false,
    };
  } catch {
    return null;
  }
}
export function checkoutOf(
  row: WorkContextRow,
  repositories: readonly ConnectedRunRepository[],
): RunCheckout {
  const recorded = recordedRepository(row.repository);
  const connected = repositories.find(
    (repo) =>
      workDigest(`${repo.host}/${repo.owner}/${repo.name}`) === row.remote ||
      repo.url === recorded?.url,
  );
  const repository = connected
    ? {
        host: connected.host,
        owner: connected.owner,
        name: connected.name,
        url: connected.url,
        connected: true,
      }
    : recorded;
  return {
    id: checkoutId(row),
    path: row.path,
    branch: nullable(row.branch),
    headSha: nullable(row.head),
    remoteDigest: nullable(row.remote),
    repository,
    firstSeq: String(row.first_seq),
    lastSeq: String(row.last_seq),
  };
}
export function capturedDiffOf(row: WorkDiffRow): RunCapturedDiff {
  const digest = nullable(row.content_digest);
  const bodyAvailable = Boolean(row.bytes_ref);
  const limitations = row.limitations.split(",").filter(Boolean);
  if (row.omitted) limitations.push(row.omitted);
  return {
    checkoutId: checkoutId(row),
    seq: String(row.seq),
    baseSha: nullable(row.base),
    headSha: nullable(row.head),
    digest,
    bodyAvailable,
    completeness: !digest
      ? "not_captured"
      : !bodyAvailable
        ? "not_retained"
        : row.complete === "true"
          ? "complete"
          : "partial",
    limitations,
    observedAt: row.ts,
  };
}
