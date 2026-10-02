// migration-run.ts: migrate_tools_to_steering, the run that starts or retries
// a workspace's move of its MCP servers into its steering repo (ADR-209 §5,
// ADR-245, #4948).
//
// migrate() in ./migrate builds the server folders and opens the steering PRs.
// This run decides whether to call it, and records each PR it opens in the
// workspace's `tool_migration` setting, so a second call answers that PR
// instead of opening another:
//
//   1. A workspace with no steering repo is refused (not_found
//      steering_repo_not_ready). Its servers have nowhere to move.
//   2. A workspace with no legacy row left to move has migrated, and the run
//      answers `already_migrated`. steeringWriter() in
//      @oxagen/agent/runtime/steering-pr reads the same rows, so the two agree
//      on what "migrated" means.
//   3. A recorded PR that is still open is answered as `already_open`.
//   4. Otherwise the run claims the setting, calls migrate() with the folders
//      on the default branch, and records each PR as it opens. It answers
//      `opened`. When migrate() opens nothing, each row left either waits on
//      the publish after its PR merged (`already_migrated`) or cannot be
//      written as a folder (conflict servers_not_movable).
//
// Steering repo provisioning calls the same run once a workspace's repo is
// ready (steering_repo.provision.ts). Everything that touches the database or
// a host is a dependency (./migration-deps), so the tests run the whole flow
// against fakes.
import type {
  MovableLegacyServer,
  OpenedSteeringPr,
} from "@oxagen/agent/runtime/steering-pr";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import type { ToolMigrationState } from "@oxagen/oxagen/contracts/tool.steering.migrate";
import { logger } from "../logger";

// ── Shapes ───────────────────────────────────────────────────────────────────

/** The workspace settings key that holds the run's record. */
export const TOOL_MIGRATION_SETTING = "tool_migration";

/**
 * How long a running migration holds the workspace. Every PR it opens saves
 * the record, which renews the hold, so only a run that stopped without saving
 * loses it.
 */
export const TOOL_MIGRATION_LEASE_MS = 10 * 60 * 1000;

export interface MigrationScope {
  orgId: string;
  workspaceId: string;
}

/** One migration steering PR as the record keeps it. */
export interface MigrationPullRequest {
  number: number;
  url: string;
  branch: string;
}

/**
 * What the `tool_migration` setting holds.
 *
 * - `running`: a run holds the workspace.
 * - `done`: the last run finished. `prs` are the PRs it opened, or the PRs an
 *   earlier run opened when it opened none.
 * - `failed`: the last run stopped on `error`. `prs` holds every PR it opened
 *   before it stopped.
 */
export interface ToolMigrationRecord {
  status: "running" | "done" | "failed";
  /** In batch order. */
  prs: MigrationPullRequest[];
  error: { code: string; message: string } | null;
  updated_at: string;
}

/** A server migrate() left behind, and why. */
export interface MigrationServerNotMoved {
  name: string;
  reason: string;
}

/** What one call of migrate() did. */
export interface MigrateCallResult {
  opened: OpenedSteeringPr[];
  /** The rows the opened PRs move. */
  movedServerIds: string[];
  notMoved: MigrationServerNotMoved[];
}

export interface MigrateCallArgs {
  /** The folders under tools/servers/ on the steering repo's default branch. */
  existingFolders: readonly string[];
  actorUserId: string | null;
  /** Called once per PR, right after it opens and before the next one does. */
  onOpened(pr: OpenedSteeringPr): Promise<void>;
}

/** Everything the run reads and writes. migration-deps.ts holds the real ones. */
export interface ToolMigrationDeps {
  now(): Date;
  /**
   * Whether the workspace has a steering repo to open a PR in. Throws
   * conflict steering_pr_unavailable when no opener is registered.
   */
  hasSteeringRepo(scope: MigrationScope): Promise<boolean>;
  /** The legacy rows a migration would move, as steeringWriter() counts them. */
  movableServers(scope: MigrationScope): Promise<MovableLegacyServer[]>;
  readRecord(scope: MigrationScope): Promise<ToolMigrationRecord | null>;
  /**
   * Write `record` unless another run holds the workspace: its record says
   * `running` and it saved after `staleBefore`. One statement, so two calls
   * cannot both claim. True when written.
   */
  claim(
    scope: MigrationScope,
    record: ToolMigrationRecord,
    staleBefore: Date,
  ): Promise<boolean>;
  saveRecord(scope: MigrationScope, record: ToolMigrationRecord): Promise<void>;
  /** Whether a steering PR is still open, and whether it merged. */
  pullRequestState(
    scope: MigrationScope,
    number: number,
  ): Promise<{ open: boolean; merged: boolean }>;
  /** The folder names under tools/servers/ on the steering repo's default branch. */
  serverFolders(scope: MigrationScope): Promise<string[]>;
  /** Call migrate() in ./migrate. */
  migrate(scope: MigrationScope, args: MigrateCallArgs): Promise<MigrateCallResult>;
}

export interface ToolMigrationResult {
  state: ToolMigrationState;
  pullRequest: { number: number; url: string } | null;
  pullRequests: { number: number; url: string }[];
}

// ── The record ───────────────────────────────────────────────────────────────

function isPullRequest(value: unknown): value is MigrationPullRequest {
  if (value === null || typeof value !== "object") return false;
  const pr = value as Record<string, unknown>;
  return (
    typeof pr["number"] === "number" &&
    Number.isInteger(pr["number"]) &&
    pr["number"] > 0 &&
    typeof pr["url"] === "string" &&
    typeof pr["branch"] === "string"
  );
}

/**
 * Read the record a workspace's settings hold, or null when they hold none.
 * A PR entry that does not parse is dropped, so a hand-edited setting cannot
 * stop the run.
 */
export function readToolMigrationRecord(settings: unknown): ToolMigrationRecord | null {
  if (settings === null || typeof settings !== "object") return null;
  const value = (settings as Record<string, unknown>)[TOOL_MIGRATION_SETTING];
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const status = raw["status"];
  if (status !== "running" && status !== "done" && status !== "failed") return null;
  const error = raw["error"] as Record<string, unknown> | null | undefined;
  return {
    status,
    prs: Array.isArray(raw["prs"]) ? raw["prs"].filter(isPullRequest) : [],
    error:
      error !== null &&
      typeof error === "object" &&
      typeof error["code"] === "string" &&
      typeof error["message"] === "string"
        ? { code: error["code"], message: error["message"] }
        : null,
    updated_at: typeof raw["updated_at"] === "string" ? raw["updated_at"] : new Date(0).toISOString(),
  };
}

// ── Answers and refusals ─────────────────────────────────────────────────────

function answer(state: ToolMigrationState, prs: readonly MigrationPullRequest[]): ToolMigrationResult {
  const pullRequests = prs.map((pr) => ({ number: pr.number, url: pr.url }));
  return { state, pullRequest: pullRequests[0] ?? null, pullRequests };
}

function conflict(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/** The refusal for a workspace with no steering repo, naming the step that sets one up. */
export function steeringRepoNotReady(): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "steering_repo_not_ready",
    message:
      "This workspace has no steering repo yet, so its MCP servers have nowhere to move. Set one up first: get_steering_repo shows where its setup stands, retry_steering_repo_provision restarts a setup that stopped, and import_workspace_steering moves a workspace still steered from a code repository's .oxagen/ folder. Then run migrate_tools_to_steering again.",
  });
}

/** A HandlerError as it is, and migrate()'s missing-opener error as a conflict. */
function refusalOf(err: unknown): unknown {
  if (isHandlerError(err)) return err;
  if (
    err instanceof Error &&
    (err as Error & { code?: unknown }).code === "steering_pr_unavailable"
  ) {
    return conflict("steering_pr_unavailable", err.message);
  }
  return err;
}

function errorOf(err: unknown): { code: string; message: string } {
  if (isHandlerError(err)) return { code: err.reason, message: err.message };
  const code = (err as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" ? code : "migration_failed",
    message: err instanceof Error ? err.message : String(err),
  };
}

function notMovableMessage(
  stuck: readonly MovableLegacyServer[],
  notMoved: readonly MigrationServerNotMoved[],
): string {
  const reasons = new Map<string, string>();
  for (const server of notMoved) if (!reasons.has(server.name)) reasons.set(server.name, server.reason);
  const lines = stuck.map(
    (row) => `${row.name}: ${reasons.get(row.name) ?? "it cannot be written as a server folder."}`,
  );
  const count = stuck.length === 1 ? "1 server" : `${stuck.length} servers`;
  return `No migration PR was opened. ${count} cannot move into the steering repo, and the workspace stays on direct writes until someone fixes, disables, or deletes each one. ${lines.join(" ")}`;
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * Start or retry the workspace's migration. Safe to call again: an open PR is
 * answered, and a migrated workspace opens nothing.
 */
export async function runToolMigration(
  scope: MigrationScope,
  options: { actorUserId: string | null },
  deps: ToolMigrationDeps,
): Promise<ToolMigrationResult> {
  if (!(await deps.hasSteeringRepo(scope))) throw steeringRepoNotReady();

  const stored = await deps.readRecord(scope);
  const recorded = stored?.prs ?? [];
  const movable = await deps.movableServers(scope);
  if (movable.length === 0) return answer("already_migrated", recorded);

  // A PR an earlier run opened that is still open. Its rows stay legacy until
  // it merges and the next publish takes them over, so they still count above.
  const states = new Map<number, { open: boolean; merged: boolean }>();
  for (const pr of recorded) states.set(pr.number, await deps.pullRequestState(scope, pr.number));
  const open = recorded.filter((pr) => states.get(pr.number)?.open === true);
  if (open.length > 0) return answer("already_open", open);
  const merged = recorded.filter((pr) => states.get(pr.number)?.merged === true);

  const started = deps.now();
  const record: ToolMigrationRecord = {
    status: "running",
    prs: [...recorded],
    error: null,
    updated_at: started.toISOString(),
  };
  const claimed = await deps.claim(
    scope,
    record,
    new Date(started.getTime() - TOOL_MIGRATION_LEASE_MS),
  );
  if (!claimed) {
    throw conflict(
      "tool_migration_running",
      "Another run is moving this workspace's MCP servers into its steering repo now. Run migrate_tools_to_steering again in a few minutes to get its pull request.",
    );
  }

  /**
   * Save the record. A save that fails is logged, not thrown: once a PR is
   * open, throwing would tell the caller nothing opened, and migrate() would
   * leave the PR's rows unmarked. The cost is that a retry cannot see the PR
   * and may open a second one, which the log names.
   */
  const save = async (message: string, fields: Record<string, unknown> = {}): Promise<void> => {
    record.updated_at = deps.now().toISOString();
    try {
      await deps.saveRecord(scope, record);
    } catch (err) {
      logger.error(
        {
          workspaceId: scope.workspaceId,
          ...fields,
          err: err instanceof Error ? err.message : String(err),
        },
        message,
      );
    }
  };
  const opened: MigrationPullRequest[] = [];
  let existingFolders: string[] = [];
  let result: MigrateCallResult;
  try {
    existingFolders = await deps.serverFolders(scope);
    // No recorded PR is open, so a row whose folder is missing from the
    // default branch belongs to a PR that closed unmerged, and migrate()
    // plans it again under the same name.
    result = await deps.migrate(scope, {
      existingFolders,
      actorUserId: options.actorUserId,
      onOpened: async (pr) => {
        opened.push({ number: pr.number, url: pr.url, branch: pr.branch });
        record.prs = [...opened];
        await save(
          "mcp-studio: a migration PR opened but was not recorded; a retry may open another",
          { pr: pr.number },
        );
      },
    });
  } catch (err) {
    record.status = "failed";
    record.prs = opened.length > 0 ? [...opened] : [...recorded];
    record.error = errorOf(err);
    await save("mcp-studio: a failed migration could not be recorded");
    throw refusalOf(err);
  }

  if (result.opened.length > 0) {
    record.status = "done";
    record.prs = result.opened.map((pr) => ({ number: pr.number, url: pr.url, branch: pr.branch }));
    await save(
      "mcp-studio: the opened migration PRs could not be recorded; a retry may open more",
      { prs: record.prs.map((pr) => pr.number) },
    );
    return answer("opened", record.prs);
  }

  // Nothing opened. A row whose folder is already on the default branch waits
  // on the publish after its PR merged. Any other row could not be written.
  const onMain = new Set(existingFolders);
  const moved = new Set(result.movedServerIds);
  const stuck = movable.filter(
    (row) => !moved.has(row.id) && !(row.steeringName !== null && onMain.has(row.steeringName)),
  );
  if (stuck.length > 0) {
    const refusal = conflict("servers_not_movable", notMovableMessage(stuck, result.notMoved));
    record.status = "failed";
    record.error = { code: refusal.reason, message: refusal.message };
    await save("mcp-studio: a refused migration could not be recorded");
    throw refusal;
  }
  record.status = "done";
  await save("mcp-studio: the migration's record could not be saved");
  return answer("already_migrated", merged);
}
