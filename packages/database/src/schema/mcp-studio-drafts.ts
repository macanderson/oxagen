// An MCP Studio draft (mcp-studio-spec, Steering PR; M11, #4686).
//
// One live draft per workspace and server name. `serverName` is the folder
// under tools/servers/ in the steering repo, so it follows
// SERVER_NAME_PATTERN in packages/oxagen/src/steering-repo/names.ts. Built-in
// tools own the name `builtin`, so no draft may take it.
//
// `ops` lists the edits the Studio has recorded, in order. `serverToml` is the
// server.toml the draft would commit. `revision` is the draft's save counter
// and starts at 1. The pr* columns name the steering pull request the draft
// opened.
//
// The draft holds no credential value. `serverToml` names a credential only by
// `oxagen:credential/<name>`.
//
// The migration that creates this table and its tenant policies is
// 20260928160000_mcp_studio_drafts.sql.
import {
  check,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { mcpSchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin, softDeleteMixin } from "./_mixins";
import { mcpServers } from "./mcp";

export const mcpStudioDrafts = mcpSchema.table(
  "studio_drafts",
  {
    ...idMixin("msd"),
    ...auditMixin(),
    ...softDeleteMixin(),
    ...orgScopeMixin(),
    serverName: text("server_name").notNull(),
    // The served server the draft edits. Null for a new server.
    mcpServerId: uuid("mcp_server_id").references(() => mcpServers.id, {
      onDelete: "set null",
    }),
    ops: jsonb("ops").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    serverToml: text("server_toml"),
    source: jsonb("source").$type<unknown>(),
    revision: integer("revision").notNull().default(1),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prBranch: text("pr_branch"),
  },
  (t) => ({
    // One live draft per server in a workspace. A deleted draft frees the name.
    serverIdx: uniqueIndex("mcp_studio_drafts_server_uq")
      .on(t.orgId, t.workspaceId, t.serverName)
      .where(sql`deleted_at IS NULL`),
    serverNameCheck: check(
      "studio_drafts_server_name_check",
      sql`${t.serverName} ~ '^[a-z][a-z0-9_]{0,23}$'`,
    ),
    serverNameReservedCheck: check(
      "studio_drafts_server_name_reserved_check",
      sql`${t.serverName} <> 'builtin'`,
    ),
    opsCheck: check(
      "studio_drafts_ops_check",
      sql`jsonb_typeof(${t.ops}) = 'array'`,
    ),
    serverTomlCheck: check(
      "studio_drafts_server_toml_check",
      sql`octet_length(${t.serverToml}) <= 262144`,
    ),
    revisionCheck: check(
      "studio_drafts_revision_check",
      sql`${t.revision} >= 1`,
    ),
  }),
);

export type McpStudioDraftRow = typeof mcpStudioDrafts.$inferSelect;
export type NewMcpStudioDraftRow = typeof mcpStudioDrafts.$inferInsert;
