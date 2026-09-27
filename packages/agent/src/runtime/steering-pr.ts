// steering-pr.ts: the seam a registry write opens a steering PR through.
//
// Once a workspace's connected servers live in its steering repo, a change
// to its tools is a steering PR, and publishing the merged version writes the
// registry rows (M13, #4478). Two ports meet here:
//
// - SteeringPrOpener opens a PR and reads a file from the default branch. M11
//   builds it.
// - ServerFolderWriter builds a server folder from mcp.mcp_servers rows and
//   opens it through the opener. @oxagen/handlers builds it in
//   mcp-studio/migrate.ts, which loads the @oxagen/mcp-studio barrel and so
//   stays out of the handlers barrel.
//
// Boot registers both. Until it does, steeringWriter() returns null and every
// caller keeps writing rows the way it always has.
//
// This file lives in @oxagen/agent because agent.mcp.register is here and
// @oxagen/agent cannot import @oxagen/handlers. The handlers import it too.
import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, withTenantDb, type Tx } from "@oxagen/database";

/** A steering PR holds at most this many files. A migration batch never splits a server folder. */
export const STEERING_PR_FILES_MAX = 299;

/**
 * The mcp.mcp_servers transports a server folder's remote source reaches:
 * streamable HTTP, which server.toml writes as http. Review refuses the older
 * HTTP+SSE transport (ADR-211), so an sse server stays a legacy row, as a
 * stdio server does.
 */
export const MOVABLE_TRANSPORTS = ["streamable-http"] as const;

export interface WorkspaceScope {
  orgId: string;
  workspaceId: string;
}

export interface SteeringPrFile {
  /** The path from the steering repo's root, such as tools/servers/github/server.toml. */
  path: string;
  content: string;
}

export interface OpenSteeringPrRequest extends WorkspaceScope {
  /** The person the PR is opened for, or null for a service run such as a migration. */
  actorUserId: string | null;
  /** Starts with the top-level folder it changes, such as tools/. */
  branch: string;
  title: string;
  body: string;
  files: readonly SteeringPrFile[];
}

export interface OpenedSteeringPr {
  number: number;
  url: string;
  branch: string;
}

export interface SteeringPrOpener {
  /** Whether the workspace has a steering repo to open a PR in. */
  hasSteeringRepo(scope: WorkspaceScope): Promise<boolean>;
  open(request: OpenSteeringPrRequest): Promise<OpenedSteeringPr>;
  /** A file's text on the steering repo's default branch, or null when the file is absent. */
  readFile(scope: WorkspaceScope, path: string): Promise<string | null>;
}

export interface AddServerRequest extends WorkspaceScope {
  /** A proposed mcp.mcp_servers row with no steering_name yet. */
  serverId: string;
  actorUserId: string | null;
}

export interface AddToolsRequest extends WorkspaceScope {
  /** An mcp.mcp_servers row with origin steering. */
  serverId: string;
  /** Upstream tool names, each pinned in mcp.tool_snapshots for the server. */
  toolNames: readonly string[];
  actorUserId: string | null;
}

/**
 * Opens the steering PRs the direct paths used to replace with row writes.
 * A server or tool the folder cannot hold is refused with a HandlerError
 * whose code is conflict, and nothing is opened.
 */
export interface ServerFolderWriter {
  /**
   * Reserve tools/servers/<name>/ by setting a proposed row's steering_name,
   * then open the folder as a steering PR. When the PR does not open, the
   * name is released and the error is rethrown.
   */
  addServer(request: AddServerRequest): Promise<OpenedSteeringPr>;
  /** Add pinned tools to a steering server's tools.toml and lock, as a steering PR. */
  addTools(request: AddToolsRequest): Promise<OpenedSteeringPr>;
}

/** No opener is registered, or the workspace has no steering repo. */
export class SteeringPrUnavailableError extends Error {
  readonly code = "steering_pr_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SteeringPrUnavailableError";
  }
}

let registered: SteeringPrOpener | null = null;
let registeredWriter: ServerFolderWriter | null = null;

/** Boot registers M11's opener. Pass null to remove it, as tests do. */
export function registerSteeringPrOpener(opener: SteeringPrOpener | null): void {
  registered = opener;
}

/** The registered opener, or null before boot registers one. */
export function steeringPrOpener(): SteeringPrOpener | null {
  return registered;
}

/** Boot registers the handlers' writer. Pass null to remove it, as tests do. */
export function registerServerFolderWriter(writer: ServerFolderWriter | null): void {
  registeredWriter = writer;
}

/**
 * The legacy rows a migration would move: live, enabled, legacy, on a remote
 * transport, and, for a plugin row, with an install that is enabled and live.
 * migrate() in @oxagen/handlers selects with the same rule.
 */
export async function countMovableLegacyServers(
  tx: Tx,
  scope: WorkspaceScope,
): Promise<number> {
  const rows = await tx
    .select({ n: count() })
    .from(schema.mcpServers)
    .leftJoin(
      schema.pluginInstalledPlugins,
      eq(schema.mcpServers.orgListingId, schema.pluginInstalledPlugins.id),
    )
    .where(
      and(
        eq(schema.mcpServers.orgId, scope.orgId),
        eq(schema.mcpServers.workspaceId, scope.workspaceId),
        eq(schema.mcpServers.origin, "legacy"),
        eq(schema.mcpServers.enabled, true),
        isNull(schema.mcpServers.deletedAt),
        inArray(schema.mcpServers.transportType, [...MOVABLE_TRANSPORTS]),
        or(
          isNull(schema.mcpServers.orgListingId),
          and(
            eq(schema.pluginInstalledPlugins.enabled, true),
            isNull(schema.pluginInstalledPlugins.deletedAt),
          ),
        ),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The writer a registry write goes through, or null when the write stays a
 * direct row write. It is non-null only when all four hold:
 *
 * - Boot registered an opener.
 * - Boot registered a writer.
 * - The workspace has a steering repo.
 * - No legacy row is left to move. A migration batch's rows stay legacy until
 *   the first publish after the batch merges takes them over, so an open
 *   batch keeps the workspace on direct writes. A remote server the migration
 *   could not move does the same until someone fixes, disables, or deletes it.
 */
export async function steeringWriter(
  scope: WorkspaceScope,
): Promise<ServerFolderWriter | null> {
  const opener = registered;
  const writer = registeredWriter;
  if (opener === null || writer === null) return null;
  if (!(await opener.hasSteeringRepo(scope))) return null;
  const movable = await withTenantDb((tx) => countMovableLegacyServers(tx, scope));
  return movable === 0 ? writer : null;
}
