// mcp.server_discoveries: the last tool discovery of each steering server
// (M10, #4682).
//
// One row per workspace and server folder (`tools/servers/<server>/`). A
// discovery asks the server's source which tools it offers now: `tools/list`
// for a remote or registry server, the local gateway's report for a local
// one, and the definition document for an OpenAPI, GraphQL, or gRPC server.
// It writes each tool to mcp.tool_snapshots and compares the upstream of each
// imported tool with the served lock. When they differ, it opens one sync
// steering PR for the server, and the row keeps that PR until it merges.
//
// `withheld` names the tools whose input schema changed upstream. The gateway
// withholds them until the sync steering PR merges. The row also keeps the
// source fields the push webhook needs to find the servers a push to a
// definition repository touches. A stored error never carries a credential.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgScopeMixin, uuidv7Default } from "./_mixins";
import { mcpSchema } from "./_schemas";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const MCP_DISCOVERY_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

/** What asked for a discovery. */
export const MCP_DISCOVERY_TRIGGERS = [
  "schedule",
  "list_changed",
  "push",
  "registry_version",
  "manual",
  "lock_merged",
] as const;

/** What a finished discovery did about the lock. */
export const MCP_DISCOVERY_OUTCOMES = [
  "unchanged",
  "pr_opened",
  "pr_updated",
  "needs_digest",
  "skipped",
] as const;

export const mcpServerDiscoveries = mcpSchema.table(
  "server_discoveries",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** The server folder name under `tools/servers/`. */
    server: text("server").notNull(),
    /** The mcp.mcp_servers row the snapshots belong to, once one exists. */
    mcpServerId: uuid("mcp_server_id"),
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").notNull(),
    requestedAt: ts("requested_at").notNull().defaultNow(),
    /** The person who asked, for a manual discovery. Operator OAuth reads it. */
    requestedBy: uuid("requested_by"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    /** Why the discovery failed, with every credential removed. */
    error: text("error"),
    outcome: text("outcome"),
    /** How many tools the source offered. */
    toolCount: integer("tool_count"),
    /** The machine whose gateway reported a local server's tools. */
    machine: text("machine"),
    /** `remote`, `registry`, `local`, `openapi`, `graphql` or `grpc`. */
    sourceKind: text("source_kind"),
    /** A definition's repository, as `github.com/owner/name`. */
    sourceRepo: text("source_repo"),
    sourcePath: text("source_path"),
    sourceRef: text("source_ref"),
    /** The server's `sync.schedule`: `on-change`, `daily` or `manual`. */
    schedule: text("schedule"),
    /** The canonical digest of the proposed lock's tools, to skip a repeat commit. */
    upstreamDigest: text("upstream_digest"),
    /** The newest version the registry lists, for a registry server. */
    latestVersion: text("latest_version"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prBranch: text("pr_branch"),
    /** Full tool names the gateway withholds until the sync steering PR merges. */
    withheld: text("withheld").array().notNull().default(sql`'{}'`),
  },
  (t) => ({
    serverUniq: uniqueIndex("server_discoveries_server_uniq").on(
      t.orgId,
      t.workspaceId,
      t.server,
    ),
    // The push webhook's lookup: every on-change server a repository feeds.
    sourceRepoIdx: index("server_discoveries_source_repo_idx")
      .on(t.sourceRepo)
      .where(sql`${t.schedule} = 'on-change'`),
    statusCheck: check(
      "server_discoveries_status_check",
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
    triggerCheck: check(
      "server_discoveries_trigger_check",
      sql`${t.trigger} IN ('schedule', 'list_changed', 'push', 'registry_version', 'manual', 'lock_merged')`,
    ),
    outcomeCheck: check(
      "server_discoveries_outcome_check",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('unchanged', 'pr_opened', 'pr_updated', 'needs_digest', 'skipped')`,
    ),
    scheduleCheck: check(
      "server_discoveries_schedule_check",
      sql`${t.schedule} IS NULL OR ${t.schedule} IN ('on-change', 'daily', 'manual')`,
    ),
    prCheck: check(
      "server_discoveries_pr_check",
      sql`${t.prNumber} IS NULL OR ${t.prNumber} > 0`,
    ),
  }),
);
