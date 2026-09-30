// An MCP Studio draft's tool listing (ADR-233, #4756).
//
// A new server that runs on machines has no tools until a machine starts it.
// `start_studio_listing` pins the draft's server and asks for one listing:
// a machine in one of `machineGroups` starts the pinned package or command,
// answers tools/list, and the MCP process that holds the machine's poll
// writes the answer into the draft as its MCP source. Review then builds the
// folder, and its first tools.lock.json, from that source.
//
// One row per draft. Asking again replaces the row. `lockSource` is the pin
// the machine checks before it starts anything, in tools.lock.json's shape.
// `draftRevision` is the revision the listing was asked on: a draft saved
// since then is not the draft that was pinned, so the listing fails and
// writes nothing.
//
// The migration that creates this table and its tenant policies is
// 20260930170000_mcp_studio_listings.sql.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgScopeMixin, uuidv7Default } from "./_mixins";
import { mcpSchema } from "./_schemas";
import { mcpStudioDrafts } from "./mcp-studio-drafts";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const MCP_STUDIO_LISTING_STATUSES = [
  // Asked for, and no machine has claimed it yet.
  "waiting_for_machine",
  // A machine's MCP process claimed it and is asking the machine.
  "running",
  "succeeded",
  "failed",
] as const;

export const mcpStudioListings = mcpSchema.table(
  "studio_listings",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => mcpStudioDrafts.id, { onDelete: "cascade" }),
    /** The draft's server name, the folder under tools/servers/. */
    serverName: text("server_name").notNull(),
    status: text("status").notNull().default("waiting_for_machine"),
    /** server.toml's source.machines: the groups whose machines may run it. */
    machineGroups: text("machine_groups")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The pinned lock source the machine checks, in tools.lock.json's shape. */
    lockSource: jsonb("lock_source").$type<unknown>().notNull(),
    /** The draft revision the listing was asked on. */
    draftRevision: integer("draft_revision").notNull(),
    /** The person who asked. */
    requestedBy: uuid("requested_by"),
    requestedAt: ts("requested_at").notNull().defaultNow(),
    /** When a machine's MCP process claimed it. */
    claimedAt: ts("claimed_at"),
    finishedAt: ts("finished_at"),
    /** The machine that answered tools/list. */
    machine: text("machine"),
    /** How many tools the machine listed. */
    toolCount: integer("tool_count"),
    /** Why the listing failed. */
    error: text("error"),
  },
  (t) => ({
    draftUniq: uniqueIndex("studio_listings_draft_uniq").on(t.draftId),
    // A polling machine's lookup: the workspace's listings a machine can take.
    openIdx: index("studio_listings_open_idx")
      .on(t.orgId, t.workspaceId, t.requestedAt)
      .where(sql`${t.status} IN ('waiting_for_machine', 'running')`),
    statusCheck: check(
      "studio_listings_status_check",
      sql`${t.status} IN ('waiting_for_machine', 'running', 'succeeded', 'failed')`,
    ),
    draftRevisionCheck: check(
      "studio_listings_draft_revision_check",
      sql`${t.draftRevision} >= 1`,
    ),
    toolCountCheck: check(
      "studio_listings_tool_count_check",
      sql`${t.toolCount} IS NULL OR ${t.toolCount} >= 0`,
    ),
  }),
);

export type McpStudioListingRow = typeof mcpStudioListings.$inferSelect;
