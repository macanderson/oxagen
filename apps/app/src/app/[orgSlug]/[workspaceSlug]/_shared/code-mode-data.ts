/**
 * code-mode-data.ts — server-only loader for the chat composer's "Code" mode
 * pickers: usable GitHub repos + workspace environments.
 *
 * Follows the direct-handler-call pattern already used in conversation-page.tsx
 * for userPreferencesReadHandler/budgetPolicyReadHandler/conversationListHandler
 * (not invoke() — apps/app doesn't bootstrap the IAM kernel invoke() expects;
 * see CLAUDE.md "apps/app does not bootstrap IAM").
 *
 * Repo derivation: connection.list has NO owner/repo/branch fields (only
 * id/publicId/connectorId/displayName/status/...) and a GitHub connection's
 * displayName is just the literal string "GitHub" (see
 * github-connection-wizard.tsx createPendingGithubConnection) — it is never
 * "owner/repo". The real owner/repo/branch live in connection.get's
 * `deliveryConfig`, written by connection.mappings.set as either
 * `{ owner, repo, defaultBranch }` (single-repo shape) or
 * `{ selectedRepos: ["owner/repo", …], defaultBranch }` (multi-repo wizard
 * shape). A connection that hasn't finished onboarding (no owner/repo and no
 * selectedRepos) yields zero usable repos and is excluded from the picker.
 */
import { runInTenantScope } from "@oxagen/tenancy";
import { connectionListHandler } from "@oxagen/handlers/connection.list";
import { connectionGetHandler } from "@oxagen/handlers/connection.get";
import { environmentListHandler } from "@oxagen/handlers/environment.list";
import { logger } from "@oxagen/handlers/logger";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { EnvironmentListOutput } from "@oxagen/oxagen/contracts/environment.list";
import type { RepoOption } from "@/components/chat/repo-selector";
import type { EnvironmentOption } from "@/components/chat/environment-selector";

/** Parse a single connection's deliveryConfig into 0+ usable {owner,name,defaultBranch} repos. */
function parseRepoEntries(
  deliveryConfig: Record<string, unknown> | null,
): Array<{ owner: string; name: string; defaultBranch: string | null }> {
  if (!deliveryConfig) return [];
  const defaultBranch =
    typeof deliveryConfig["defaultBranch"] === "string"
      ? (deliveryConfig["defaultBranch"] as string)
      : null;

  const owner =
    typeof deliveryConfig["owner"] === "string"
      ? (deliveryConfig["owner"] as string)
      : undefined;
  const repo =
    typeof deliveryConfig["repo"] === "string"
      ? (deliveryConfig["repo"] as string)
      : undefined;
  if (owner && repo) return [{ owner, name: repo, defaultBranch }];

  const selectedRepos = Array.isArray(deliveryConfig["selectedRepos"])
    ? (deliveryConfig["selectedRepos"] as unknown[])
    : [];
  const out: Array<{
    owner: string;
    name: string;
    defaultBranch: string | null;
  }> = [];
  for (const full of selectedRepos) {
    if (typeof full !== "string") continue;
    const slash = full.indexOf("/");
    if (slash <= 0 || slash === full.length - 1) continue; // malformed "owner/" or "/repo" — excluded
    out.push({
      owner: full.slice(0, slash),
      name: full.slice(slash + 1),
      defaultBranch,
    });
  }
  return out;
}

export interface CodeModeOptions {
  repos: RepoOption[];
  environments: EnvironmentOption[];
}

const EMPTY: CodeModeOptions = { repos: [], environments: [] };

/** Max GitHub connections enriched (one connection.get each) for the repo
 * picker — bounds the blocking fan-out on the chat page's critical path. */
const CODE_MODE_CONNECTION_LIMIT = 10;

/**
 * Loads the repo + environment options for the code-mode pickers. Never
 * throws — a failure on either read degrades to an empty list so the chat
 * page's Promise.all never crashes because code mode couldn't populate.
 */
export async function loadCodeModeOptions(
  orgId: string,
  workspaceId: string,
  ctx: CapabilityContext,
): Promise<CodeModeOptions> {
  try {
    return await runInTenantScope({ orgId, workspaceId }, async () => {
      const [connectionsResult, environmentsResult] = await Promise.all([
        connectionListHandler({ connectorId: "github" }, ctx).catch(
          (err: unknown) => {
            logger.warn(
              { err, orgId, workspaceId },
              "code-mode-data: connection.list failed — no repos",
            );
            return { connections: [] };
          },
        ),
        // environmentListHandler is typed as the generic CapabilityHandlerFn
        // (unknown return) rather than CapabilityHandler<typeof environmentList>
        // — cast to the contract's real output shape.
        (
          environmentListHandler({}, ctx) as Promise<EnvironmentListOutput>
        ).catch((err: unknown): EnvironmentListOutput => {
          logger.warn(
            { err, orgId, workspaceId },
            "code-mode-data: environment.list failed — no environments",
          );
          return { environments: [] };
        }),
      ]);

      // Only "connected" GitHub connections have a live sandbox target — a
      // pending_setup/paused/error connection has no reliable owner/repo yet.
      const allUsable = connectionsResult.connections.filter(
        (c) => c.status === "connected",
      );
      // Bound the per-connection connection.get fan-out: this runs on the
      // chat page's blocking path, so an unbounded workspace must not turn
      // into an unbounded burst of handler calls (same idiom as
      // workflows.ts ENRICH_LIMIT / agents.ts limit=3).
      const usableConnections = allUsable.slice(0, CODE_MODE_CONNECTION_LIMIT);
      if (allUsable.length > usableConnections.length) {
        logger.warn(
          {
            orgId,
            workspaceId,
            total: allUsable.length,
            limit: CODE_MODE_CONNECTION_LIMIT,
          },
          "code-mode-data: repo picker truncated to the first connections — raise CODE_MODE_CONNECTION_LIMIT or batch deliveryConfig into connection.list if this fires in practice",
        );
      }

      const repoLists = await Promise.all(
        usableConnections.map(async (c) => {
          try {
            const detail = await connectionGetHandler(
              { connectionId: c.publicId },
              ctx,
            );
            return parseRepoEntries(detail.deliveryConfig).map(
              (entry): RepoOption => ({
                key: `${c.publicId}::${entry.owner}/${entry.name}`,
                connectionId: c.publicId,
                owner: entry.owner,
                name: entry.name,
                defaultBranch: entry.defaultBranch,
              }),
            );
          } catch (err) {
            logger.warn(
              { err, connectionId: c.publicId, orgId, workspaceId },
              "code-mode-data: connection.get failed for a repo candidate — excluded",
            );
            return [];
          }
        }),
      );

      return {
        repos: repoLists.flat(),
        environments: environmentsResult.environments
          .filter((e) => e.isActive)
          .map(
            (e): EnvironmentOption => ({
              id: e.id,
              name: e.name,
              isDefault: e.isDefault,
            }),
          ),
      };
    });
  } catch (err) {
    logger.warn(
      { err, orgId, workspaceId },
      "code-mode-data: loadCodeModeOptions failed — degraded",
    );
    return EMPTY;
  }
}
