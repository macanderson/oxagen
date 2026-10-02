import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * migrate_tools_to_steering: move the workspace's connected MCP servers into
 * its steering repo (ADR-209 §5, ADR-245, #4948).
 *
 * The migration opens one steering PR, or one per batch of at most 299 files,
 * with a `tools/servers/<name>/` folder for each server a wrapped agent may
 * use. When the PRs merge, the next publish takes each server's row over, and
 * from then on a change to the workspace's tools is a steering PR.
 *
 * The call is safe to repeat. It answers one of three states:
 *
 * - `opened`: this call opened the migration PRs.
 * - `already_open`: a migration PR an earlier call opened is still open, and
 *   the call answers it instead of opening a second.
 * - `already_migrated`: no server is left to move, or every one left waits
 *   on the publish after its PR merged. Nothing is opened.
 *
 * Refusals: not_found `steering_repo_not_ready` (the workspace has no steering
 * repo yet), conflict `servers_not_movable` (a server cannot be written as a
 * folder, so nothing could move), conflict `tool_migration_running` (another
 * call is moving the workspace's servers now), and conflict
 * `steering_pr_unavailable` (this deployment registered no steering PR
 * opener).
 *
 * Steering repo provisioning starts the same migration once the workspace's
 * repo is ready, so this capability is the manual start and the retry.
 *
 * Org Owners and Admins only. The handler checks the role itself (INV-29).
 */
export const TOOL_MIGRATION_STATES = [
  "opened",
  "already_open",
  "already_migrated",
] as const;

export type ToolMigrationState = (typeof TOOL_MIGRATION_STATES)[number];

/** One migration steering PR. */
export const toolMigrationPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url(),
  })
  .strict();

export const toolSteeringMigrate = registerCapability({
  name: "migrate_tools_to_steering",
  domain: "tool",
  description:
    "Move the workspace's connected MCP servers into its steering repo by opening the migration steering PR. Safe to repeat: answers the open PR, or that the workspace has already migrated, instead of opening a second one.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs"],
  scoped: true,
  // Opening a PR spends no model tokens.
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({}).strict(),
  output: z
    .object({
      state: z.enum(TOOL_MIGRATION_STATES),
      /** The first migration PR, or null when the workspace never needed one. */
      pullRequest: toolMigrationPullRequestSchema.nullable(),
      /** Every migration PR in batch order. One in most workspaces. */
      pullRequests: z.array(toolMigrationPullRequestSchema),
    })
    .strict(),
});

export type ToolSteeringMigrateInput = z.output<typeof toolSteeringMigrate.input>;
export type ToolSteeringMigrateOutput = z.output<typeof toolSteeringMigrate.output>;
