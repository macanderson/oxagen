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
  observed_at: string;
  base: string;
  content_digest: string;
  bytes_ref: string;
  complete: string;
  limitations: string;
  omitted: string;
  /** The frame's `content.redactions`, as the JSON text the row holds. */
  redactions: string;
  /** How many redactions the recorder made, from the frame's attrs. */
  redaction_count: number | string;
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
  first_seq: number | string;
  first_ts: string;
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

// Two rules hold for every `tacho_events` read in this file.
//
// No alias reuses a column name. A ClickHouse alias applies to the whole
// query, so `min(seq) AS seq` turned every other `seq` into `min(seq)` and
// `argMin(ts, seq)` into an aggregate inside an aggregate (code 184). That one
// alias failed every `get_run_work` call in production. `run-work.test.ts`
// checks each query against the table's columns.
//
// No read filters on `chain_verified`. A fact comes from every frame the
// control plane accepted from the session's host, and a broken chain is
// reported beside the facts, never by hiding them (ADR-171).
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
        AND session_uuid = {sessionUuid:UUID}
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
        AND session_uuid = {sessionUuid:UUID}
        AND kind IN ('subagent_start', 'subagent_stop')
        AND attrs['hook.agent_id'] != ''
      GROUP BY id ORDER BY first_seq ASC LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit: WORK_SUBAGENT_CAP + 1 },
  });
  return result.data;
}
/**
 * One pull-request attr of a frame, as a ClickHouse expression, under either
 * name it was written with. `oxagen:pr_link` frames and `pr_open` effect
 * frames write `pr.url`, `pr.number` and `pr.repository`. An `oxagen:pr_link`
 * frame stored before #3944 carries `pr_url`, `pr_number` and
 * `pr_repository`. The frame's `pr.url` decides which set is read, so a
 * number is never paired with a URL from the other set.
 */
export function prAttr(name: "url" | "number" | "repository"): string {
  return `if(attrs['pr.url'] != '', attrs['pr.${name}'], attrs['pr_${name}'])`;
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
    query: `SELECT ${prAttr("url")} AS url,
      argMin(${prAttr("number")}, seq) AS number,
      argMaxIf(${prAttr("repository")}, seq, ${prAttr("repository")} != '') AS repository,
      min(seq) AS first_seq, toString(argMin(ts, seq)) AS first_ts
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
        AND kind = 'oxagen:pr_link' AND ${prAttr("url")} != ''
      GROUP BY url ORDER BY first_seq ASC LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit: WORK_PR_LINK_CAP + 1 },
  });
  return result.data;
}
/**
 * A linked PR as `owner`, `name` and `number`. The frame's repository attr
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
/** Where a run's effort was read (#3891). */
export type EffortSource = "request" | "harness";

/**
 * The effort and thinking settings a wrapped session last recorded.
 * `effortSource` says where `effort` was read (#3891): `request` from a
 * proxied request body, which wins, or `harness`. It is null exactly when
 * `effort` is.
 */
export type SessionConfig = {
  effort: string | null;
  effortSource: EffortSource | null;
  thinking: boolean | null;
};

/**
 * The session's effort and thinking settings.
 *
 * Effort is read in this order, and the first one recorded wins:
 * 1. The latest `request_effort`: the setting a proxied model request's body
 *    carried, which is what the vendor received (source `request`).
 * 2. The latest `effort_level_setting` from a session config frame.
 * 3. The latest non-empty `effort` any frame carried.
 *
 * The last two are the harness's own report (source `harness`). Thinking is
 * the latest `always_thinking_enabled`. Each is null when no frame recorded
 * it.
 */
export async function readSessionConfig(
  sessionUuid: string,
): Promise<SessionConfig> {
  const result = await chSelect<{
    requested: string;
    setting: string;
    reported_effort: string;
    thinking: string;
  }>({
    query: `SELECT
        argMaxIf(request_effort, seq, request_effort != '') AS requested,
        argMaxIf(effort_level_setting, seq, effort_level_setting != '') AS setting,
        argMaxIf(effort, seq, effort != '') AS reported_effort,
        ifNull(toString(argMaxIf(always_thinking_enabled, seq,
          always_thinking_enabled IS NOT NULL)), '') AS thinking
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}`,
    params: { sessionUuid },
  });
  const row = result.data[0];
  const requested = row?.requested.trim() ?? "";
  const reported = row?.setting.trim() || row?.reported_effort.trim() || "";
  return {
    ...(requested !== ""
      ? { effort: requested, effortSource: "request" as const }
      : reported !== ""
        ? { effort: reported, effortSource: "harness" as const }
        : { effort: null, effortSource: null }),
    thinking:
      row?.thinking === "true"
        ? true
        : row?.thinking === "false"
          ? false
          : null,
  };
}

/**
 * A run's effort and where it was read, as `get_run` answers it and the Model
 * fit reading reads it (#3891, #3893). The session's own frames win; the
 * effort the session row carries (the harness's report ingest folded) stands
 * in when the frames could not be read or recorded none. One function, so the
 * Run page's rig and the reading's effort card cannot disagree.
 */
export function runEffortOf(
  config: SessionConfig | null,
  rowEffort: string | null | undefined,
): { effort: string | null; effortSource: EffortSource | null } {
  if (config?.effort != null)
    return {
      effort: config.effort,
      effortSource: config.effortSource ?? "harness",
    };
  const reported = rowEffort?.trim() ?? "";
  return reported === ""
    ? { effort: null, effortSource: null }
    : { effort: reported, effortSource: "harness" };
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
        AND session_uuid = {sessionUuid:UUID}
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
      attrs['diff_head_sha'] AS head, attrs['repository_url'] AS repository, seq, toString(ts) AS observed_at,
      attrs['diff_base_sha'] AS base, content_digest, bytes_ref,
      attrs['diff_complete'] AS complete, attrs['diff_limitations'] AS limitations,
      attrs['body_omitted'] AS omitted, redactions,
      toUInt32OrZero(attrs['oxagen.content_redactions_total']) AS redaction_count
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
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

/**
 * A context that names a path and nothing else. The daemon seals a session's
 * first hook before its first Git read, so that frame carries the `cwd` with
 * no branch, remote, head, or repository (#3791). A detached HEAD still
 * records its head and remote, so it is never path-only.
 */
function pathOnly(row: WorkContextRow): boolean {
  return (
    row.branch === "" &&
    row.remote === "" &&
    row.head === "" &&
    row.repository === ""
  );
}

/**
 * The Git context a path-only frame at `seq` belongs to, among `others`,
 * every context the read returned but the path-only row the frame is in.
 * First choice is a Git context at `path` whose recorded span contains the
 * frame. The read groups a context's frames into one row, so a context the
 * session left and came back to keeps its early start, and only its span
 * shows the session was back in it. When several contexts span the frame,
 * the one that started last wins. A fold into a span that holds the frame
 * stretches nothing.
 *
 * Next is the context that starts next after the frame, when it is a Git
 * context at `path`: the Git read the daemon ran right after that hook.
 * Failing that, it is the context that started last before the frame, when
 * that is a Git context at `path`: the one in effect when the frame was
 * sealed. When another context starts in between, it separates the frame
 * from that Git context, and the frame folds into neither.
 */
function foldTarget(
  path: string,
  seq: number,
  others: readonly WorkContextRow[],
): WorkContextRow | undefined {
  const gitAt = (row: WorkContextRow | undefined) =>
    row !== undefined && row.path === path && !pathOnly(row) ? row : undefined;
  let around: WorkContextRow | undefined;
  let next: WorkContextRow | undefined;
  let previous: WorkContextRow | undefined;
  for (const candidate of others) {
    const start = Number(candidate.first_seq);
    if (
      gitAt(candidate) !== undefined &&
      start <= seq &&
      seq <= Number(candidate.last_seq) &&
      (around === undefined || start > Number(around.first_seq))
    )
      around = candidate;
    if (start > seq) {
      if (next === undefined || start < Number(next.first_seq))
        next = candidate;
    } else if (previous === undefined || start > Number(previous.first_seq))
      previous = candidate;
  }
  return around ?? gitAt(next) ?? gitAt(previous);
}

/**
 * Fold each path-only context into the Git context recorded at the same path,
 * so a session's first hook is not a checkout of its own that no repository
 * or branch can match. The merged row keeps the Git context's branch, remote,
 * head, and repository, and spans both rows' sequences. Contexts that name a
 * branch or remote are never merged with each other, so a branch switch or a
 * second repository stays its own checkout. A path-only row with no Git
 * context at its path stays too: a directory outside Git is a real location.
 *
 * The read groups every path-only frame at a path into one row, which can
 * cover frames seen at different times: a first hook, and a later one after
 * the session moved elsewhere. So the row's first and last frames, the two
 * it knows, each fold on their own (`foldTarget`), and neither stretches a
 * Git context past the start of another context. A frame that folds into
 * nothing stays a path-only checkout. Every decision reads the spans the
 * read returned, never one an earlier fold widened.
 *
 * `alias` maps a row that folded whole to the checkout id its first frame
 * folded into, so a captured diff never points at a checkout the read no
 * longer returns. A row that stays in part keeps its own id.
 */
export function foldProvisionalContexts(rows: readonly WorkContextRow[]): {
  rows: WorkContextRow[];
  alias: Map<string, string>;
} {
  const alias = new Map<string, string>();
  // Each Git context's merged copy, by the row the read returned.
  const merged = new Map<WorkContextRow, WorkContextRow>();
  for (const row of rows) if (!pathOnly(row)) merged.set(row, { ...row });
  const folded: WorkContextRow[] = [...merged.values()];
  for (const row of rows) {
    if (!pathOnly(row)) continue;
    const others = rows.filter((other) => other !== row);
    // Fold the frame at `seq` into its Git context's merged copy, and answer
    // that copy, or undefined when the frame stays.
    const place = (seq: number | string): WorkContextRow | undefined => {
      const target = foldTarget(row.path, Number(seq), others);
      const copy = target === undefined ? undefined : merged.get(target);
      if (copy === undefined) return undefined;
      if (Number(seq) < Number(copy.first_seq)) copy.first_seq = seq;
      if (Number(seq) > Number(copy.last_seq)) copy.last_seq = seq;
      return copy;
    };
    const first = place(row.first_seq);
    const last =
      Number(row.last_seq) === Number(row.first_seq)
        ? first
        : place(row.last_seq);
    if (first !== undefined && last !== undefined) {
      alias.set(checkoutId(row), checkoutId(first));
      continue;
    }
    folded.push({
      ...row,
      first_seq: first === undefined ? row.first_seq : row.last_seq,
      last_seq: last === undefined ? row.last_seq : row.first_seq,
    });
  }
  folded.sort((a, b) => Number(a.first_seq) - Number(b.first_seq));
  return { rows: folded, alias };
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
/**
 * Whether the recorder redacted the frame's bytes before it sealed them. The
 * collector sets `diff_complete` from the snapshot, before the seal redacts a
 * credential out of the patch, so the flag alone calls a sanitized patch
 * exact (#3791). The attr counts every redaction and the column lists at most
 * the first few, so either one shows it.
 */
function redactedOf(
  row: Pick<WorkDiffRow, "redactions" | "redaction_count">,
): boolean {
  if (Number(row.redaction_count) > 0) return true;
  try {
    const listed: unknown = JSON.parse(row.redactions);
    return Array.isArray(listed) && listed.length > 0;
  } catch {
    // A frame with no content leaves the column empty. It lists nothing.
    return false;
  }
}

export function capturedDiffOf(row: WorkDiffRow): RunCapturedDiff {
  const digest = nullable(row.content_digest);
  const bodyAvailable = Boolean(row.bytes_ref);
  const limitations = row.limitations.split(",").filter(Boolean);
  if (row.omitted) limitations.push(row.omitted);
  const redacted = redactedOf(row);
  if (redacted) limitations.push("content_redacted");
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
        : row.complete === "true" && !redacted
          ? "complete"
          : "partial",
    limitations,
    observedAt: row.observed_at,
  };
}
