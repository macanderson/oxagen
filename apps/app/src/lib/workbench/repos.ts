/**
 * workbench/repos.ts — server-side wrappers over the `repo.*` + `agent.repo.edit`
 * + `agent.file_lock.*` capabilities.
 *
 * A "repo" in this surface is a GitHub-typed `source_connections` row (one
 * connection = one repo, per connection.mappings.set's "a GitHub connection's
 * display name is always the repo slug it's bound to — owner/repo" invariant).
 * The `[connectionId]` route param and the `repoId` input these row-scoped
 * capabilities (sync/pause/resume/metrics/configure) take are the connection's
 * `publicId` — never the raw UUID (sourceConnectionRefCondition accepts either,
 * but publicId is the only id this UI ever shows or passes).
 *
 * The GitHub-API-backed capabilities (branch.create, pr.*, ci.status, file.put,
 * agent.repo.edit) do NOT take a repoId at all — they operate directly against
 * `owner`/`repo` (GitHub org + repo name) via the workspace's GitHub App token.
 * `parseRepoSlug` derives `{ owner, repo }` from a connection's displayName.
 *
 * These contracts declare surfaces without "app" (agent/api/mcp only), so
 * every call here uses the `{ surface: "agent" }` call-option — exactly like
 * the sandboxes/agents wrappers. The kernel scopes every call to org+workspace
 * from ctx; apps/app supplies the IAM (canManage) gate at the action layer.
 *
 * Server-only. Never import from a "use client" module.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import type { RepoSyncInput, RepoSyncOutput } from "@oxagen/oxagen/contracts/repo.sync";
import type { RepoPauseOutput } from "@oxagen/oxagen/contracts/repo.pause";
import type { RepoResumeOutput } from "@oxagen/oxagen/contracts/repo.resume";
import type { RepoMetricsOutput } from "@oxagen/oxagen/contracts/repo.metrics";
import type {
  RepoConfigureInput,
  RepoConfigureOutput,
} from "@oxagen/oxagen/contracts/repo.configure";
import type { RepoCreateInput, RepoCreateOutput } from "@oxagen/oxagen/contracts/repo.create";
import type { RepoForkInput, RepoForkOutput } from "@oxagen/oxagen/contracts/repo.fork";
import type {
  RepoBranchCreateInput,
  RepoBranchCreateOutput,
} from "@oxagen/oxagen/contracts/repo.branch.create";
import type { RepoPrOpenInput, RepoPrOpenOutput } from "@oxagen/oxagen/contracts/repo.pr.open";
import type { RepoPrGetInput, RepoPrGetOutput } from "@oxagen/oxagen/contracts/repo.pr.get";
import type { RepoPrDiffInput, RepoPrDiffOutput } from "@oxagen/oxagen/contracts/repo.pr.diff";
import type {
  RepoCiStatusInput,
  RepoCiStatusOutput,
} from "@oxagen/oxagen/contracts/repo.ci.status";
import type { RepoFilePutInput, RepoFilePutOutput } from "@oxagen/oxagen/contracts/repo.file.put";
import type {
  AgentRepoEditInput,
  AgentRepoEditOutput,
} from "@oxagen/oxagen/contracts/agent.repo.edit";
import type {
  AgentFileLockListInput,
  AgentFileLockListOutput,
} from "@oxagen/oxagen/contracts/agent.file_lock.list";
import type { AgentFileLockReleaseOutput } from "@oxagen/oxagen/contracts/agent.file_lock.release";
import type { WorkbenchCtx } from "./scope";

export type RepoConnection = ConnectionListOutput["connections"][number];
export type RepoMetrics = RepoMetricsOutput;
export type RepoLock = AgentFileLockListOutput["locks"][number];

/** A row the list/detail UI renders: the connection plus its resolved metrics. */
export interface RepoRow extends RepoConnection {
  metrics: RepoMetrics | null;
  metricsError: string | null;
}

// Re-exported for existing/older call sites — the parser itself lives in the
// client-safe repo-slug.ts (no server imports) so client components can use
// it too without pulling this server-only module into the client bundle.
export { parseRepoSlug } from "./repo-slug";

// ── Reads ────────────────────────────────────────────────────────────────────

/** List every GitHub-typed connection ("repo") in the workspace. */
export async function listRepoConnections(ctx: WorkbenchCtx): Promise<RepoConnection[]> {
  const out = (await invoke(
    "list_connections",
    { connectorId: "github" },
    ctx,
    { surface: "agent" },
  )) as ConnectionListOutput;
  return out.connections;
}

/** listRepoConnections plus a best-effort per-repo repo.metrics call, gracefully degraded. */
export async function listReposWithMetrics(ctx: WorkbenchCtx): Promise<RepoRow[]> {
  const connections = await listRepoConnections(ctx);
  const rows = await Promise.all(
    connections.map(async (connection): Promise<RepoRow> => {
      try {
        const metrics = await getRepoMetrics(ctx, connection.publicId);
        return { ...connection, metrics, metricsError: null };
      } catch (err) {
        return {
          ...connection,
          metrics: null,
          metricsError: err instanceof Error ? err.message : "Failed to load metrics.",
        };
      }
    }),
  );
  return rows;
}

export async function getRepoMetrics(ctx: WorkbenchCtx, repoId: string): Promise<RepoMetrics> {
  return (await invoke("get_repo_metrics", { repoId }, ctx, {
    surface: "agent",
  })) as RepoMetricsOutput;
}

export async function getPr(ctx: WorkbenchCtx, input: RepoPrGetInput): Promise<RepoPrGetOutput> {
  return (await invoke("get_pr", input, ctx, { surface: "agent" })) as RepoPrGetOutput;
}

export async function getPrDiff(
  ctx: WorkbenchCtx,
  input: RepoPrDiffInput,
): Promise<RepoPrDiffOutput> {
  return (await invoke("get_pr_diff", input, ctx, { surface: "agent" })) as RepoPrDiffOutput;
}

export async function getCiStatus(
  ctx: WorkbenchCtx,
  input: RepoCiStatusInput,
): Promise<RepoCiStatusOutput> {
  return (await invoke("get_ci_status", input, ctx, { surface: "agent" })) as RepoCiStatusOutput;
}

export async function listFileLocks(
  ctx: WorkbenchCtx,
  input: AgentFileLockListInput,
): Promise<RepoLock[]> {
  const out = (await invoke("list_file_locks", input, ctx, {
    surface: "agent",
  })) as AgentFileLockListOutput;
  return out.locks;
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function syncRepo(ctx: WorkbenchCtx, input: RepoSyncInput): Promise<RepoSyncOutput> {
  return (await invoke("sync_repo", input, ctx, { surface: "agent" })) as RepoSyncOutput;
}

export async function pauseRepo(ctx: WorkbenchCtx, repoId: string): Promise<RepoPauseOutput> {
  return (await invoke("pause_repo", { repoId }, ctx, { surface: "agent" })) as RepoPauseOutput;
}

export async function resumeRepo(ctx: WorkbenchCtx, repoId: string): Promise<RepoResumeOutput> {
  return (await invoke("resume_repo", { repoId }, ctx, {
    surface: "agent",
  })) as RepoResumeOutput;
}

export async function configureRepo(
  ctx: WorkbenchCtx,
  input: RepoConfigureInput,
): Promise<RepoConfigureOutput> {
  return (await invoke("configure_repo", input, ctx, {
    surface: "agent",
  })) as RepoConfigureOutput;
}

export async function createRepo(
  ctx: WorkbenchCtx,
  input: RepoCreateInput,
): Promise<RepoCreateOutput> {
  return (await invoke("create_repo", input, ctx, { surface: "agent" })) as RepoCreateOutput;
}

export async function forkRepo(ctx: WorkbenchCtx, input: RepoForkInput): Promise<RepoForkOutput> {
  return (await invoke("fork_repo", input, ctx, { surface: "agent" })) as RepoForkOutput;
}

export async function createBranch(
  ctx: WorkbenchCtx,
  input: RepoBranchCreateInput,
): Promise<RepoBranchCreateOutput> {
  return (await invoke("create_branch", input, ctx, {
    surface: "agent",
  })) as RepoBranchCreateOutput;
}

export async function openPr(
  ctx: WorkbenchCtx,
  input: RepoPrOpenInput,
): Promise<RepoPrOpenOutput> {
  return (await invoke("open_pr", input, ctx, { surface: "agent" })) as RepoPrOpenOutput;
}

export async function putRepoFile(
  ctx: WorkbenchCtx,
  input: RepoFilePutInput,
): Promise<RepoFilePutOutput> {
  return (await invoke("put_repo_file", input, ctx, {
    surface: "agent",
  })) as RepoFilePutOutput;
}

export async function editRepoFile(
  ctx: WorkbenchCtx,
  input: AgentRepoEditInput,
): Promise<AgentRepoEditOutput> {
  return (await invoke("edit_repo_file", input, ctx, {
    surface: "agent",
  })) as AgentRepoEditOutput;
}

export async function releaseFileLock(
  ctx: WorkbenchCtx,
  lockId: string,
): Promise<AgentFileLockReleaseOutput> {
  return (await invoke("release_file_lock", { lockId }, ctx, {
    surface: "agent",
  })) as AgentFileLockReleaseOutput;
}
