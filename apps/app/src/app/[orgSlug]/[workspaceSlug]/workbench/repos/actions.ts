"use server";
/**
 * workbench/repos/actions.ts — server actions for the Repos (list + detail)
 * surface.
 *
 * Every mutating action follows the house pattern (mirrors
 * workbench/sandboxes/actions.ts):
 *   1. zod safeParse the client payload (never trust the client),
 *   2. resolveWorkbenchScope → session + org + workspace + IAM,
 *   3. gate on `canManage` (workspace Owner/Admin) — apps/app does NOT
 *      bootstrap IAM through invoke(), so this IS the authorization gate,
 *   4. call the lib/workbench/repos helper (invoke with surface "agent"),
 *   5. return a discriminated union { ok: true, … } | { ok: false, error }.
 *
 * Read-only actions (refresh, get PR, get PR diff, get CI status, list file
 * locks) mirror the page's own gating (any resolved workspace member) — no
 * canManage check — same exception `refreshSandboxesAction` carves out.
 *
 * `owner`/`repo` (GitHub org + repo name) drive every GitHub-API-backed
 * capability (branch/PR/CI/file/agent-edit); `repoId` (the connection's
 * publicId) drives only the connection-row capabilities (sync/pause/resume/
 * metrics/configure). See lib/workbench/repos.ts for the full rationale.
 */
import "@oxagen/handlers/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { workspace } from "@/lib/routes";
import {
  listReposWithMetrics,
  getRepoMetrics,
  syncRepo,
  pauseRepo,
  resumeRepo,
  configureRepo,
  createRepo,
  forkRepo,
  createBranch,
  openPr,
  getPr,
  getPrDiff,
  getCiStatus,
  putRepoFile,
  editRepoFile,
  listFileLocks,
  releaseFileLock,
  type RepoRow,
  type RepoLock,
} from "@/lib/workbench/repos";
import type { RepoMetricsOutput } from "@oxagen/oxagen/contracts/repo.metrics";
import type { RepoSyncOutput } from "@oxagen/oxagen/contracts/repo.sync";
import type { RepoPauseOutput } from "@oxagen/oxagen/contracts/repo.pause";
import type { RepoResumeOutput } from "@oxagen/oxagen/contracts/repo.resume";
import type { RepoConfigureOutput } from "@oxagen/oxagen/contracts/repo.configure";
import type { RepoCreateOutput } from "@oxagen/oxagen/contracts/repo.create";
import type { RepoForkOutput } from "@oxagen/oxagen/contracts/repo.fork";
import type { RepoBranchCreateOutput } from "@oxagen/oxagen/contracts/repo.branch.create";
import type { RepoPrOpenOutput } from "@oxagen/oxagen/contracts/repo.pr.open";
import type { RepoPrGetOutput } from "@oxagen/oxagen/contracts/repo.pr.get";
import type { RepoPrDiffOutput } from "@oxagen/oxagen/contracts/repo.pr.diff";
import type { RepoCiStatusOutput } from "@oxagen/oxagen/contracts/repo.ci.status";
import type { RepoFilePutOutput } from "@oxagen/oxagen/contracts/repo.file.put";
import type { AgentRepoEditOutput } from "@oxagen/oxagen/contracts/agent.repo.edit";

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const MANAGE_ERROR = "Only workspace owners and admins can do this.";

// ── Refresh the list (read) ───────────────────────────────────────────────────

const refreshSchema = z.object({ ...scopeShape });

export async function refreshReposAction(
  input: z.input<typeof refreshSchema>,
): Promise<ActionResult<{ repos: RepoRow[] }>> {
  const parsed = refreshSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  try {
    const repos = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => listReposWithMetrics(ctx),
    );
    return { ok: true, repos };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: refreshReposAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to load repos.") };
  }
}

// ── Single-repo metrics (read; Overview tab retry) ──────────────────────────

const getMetricsSchema = z.object({ ...scopeShape, repoId: z.string().min(1) });

export async function getRepoMetricsAction(
  input: z.input<typeof getMetricsSchema>,
): Promise<ActionResult<{ metrics: RepoMetricsOutput }>> {
  const parsed = getMetricsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, repoId } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  try {
    const metrics = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => getRepoMetrics(ctx, repoId),
    );
    return { ok: true, metrics };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, repoId },
      "workbench.repos: getRepoMetricsAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to load repo metrics."),
    };
  }
}

// ── Sync now ───────────────────────────────────────────────────────────────

const syncSchema = z.object({
  ...scopeShape,
  repoId: z.string().min(1),
  mode: z.enum(["incremental", "full"]).default("incremental"),
  recordTypes: z.array(z.string()).optional(),
});

export async function syncRepoAction(
  input: z.input<typeof syncSchema>,
): Promise<ActionResult<{ result: RepoSyncOutput }>> {
  const parsed = syncSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, repoId, mode, recordTypes } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => syncRepo(ctx, { repoId, mode, recordTypes }),
    );
    revalidatePath(workspace.workbench.repos({ orgSlug, workspaceSlug }));
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, repoId },
      "workbench.repos: syncRepoAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to sync repo.") };
  }
}

// ── Pause / Resume ───────────────────────────────────────────────────────────

const repoIdSchema = z.object({ ...scopeShape, repoId: z.string().min(1) });

export async function pauseRepoAction(
  input: z.input<typeof repoIdSchema>,
): Promise<ActionResult<{ result: RepoPauseOutput }>> {
  const parsed = repoIdSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, repoId } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => pauseRepo(ctx, repoId),
    );
    revalidatePath(workspace.workbench.repos({ orgSlug, workspaceSlug }));
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, repoId },
      "workbench.repos: pauseRepoAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to pause repo.") };
  }
}

export async function resumeRepoAction(
  input: z.input<typeof repoIdSchema>,
): Promise<ActionResult<{ result: RepoResumeOutput }>> {
  const parsed = repoIdSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, repoId } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => resumeRepo(ctx, repoId),
    );
    revalidatePath(workspace.workbench.repos({ orgSlug, workspaceSlug }));
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, repoId },
      "workbench.repos: resumeRepoAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to resume repo.") };
  }
}

// ── Configure ────────────────────────────────────────────────────────────────

const configureSchema = z.object({
  ...scopeShape,
  repoId: z.string().min(1),
  recordTypes: z.array(z.string()).optional(),
  pathFilters: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  labelFilters: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  syncCadence: z.enum(["manual", "polling", "webhook"]).optional(),
  pollingIntervalSeconds: z.number().int().positive().optional(),
  fieldMappings: z.record(z.string()).optional(),
});

export async function configureRepoAction(
  input: z.input<typeof configureSchema>,
): Promise<ActionResult<{ result: RepoConfigureOutput }>> {
  const parsed = configureSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => configureRepo(ctx, rest),
    );
    revalidatePath(workspace.workbench.repos({ orgSlug, workspaceSlug }));
    return { ok: true, result };
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        repoId: rest.repoId,
      },
      "workbench.repos: configureRepoAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to configure repo.") };
  }
}

// ── Create repo ──────────────────────────────────────────────────────────────

const createRepoSchema = z.object({
  ...scopeShape,
  org: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1, "Name the repository."),
  description: z.string().trim().max(2_000).optional(),
  private: z.boolean().optional(),
  autoInit: z.boolean().optional(),
});

export async function createRepoAction(
  input: z.input<typeof createRepoSchema>,
): Promise<ActionResult<{ result: RepoCreateOutput }>> {
  const parsed = createRepoSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => createRepo(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: createRepoAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to create repo.") };
  }
}

// ── Fork repo ────────────────────────────────────────────────────────────────

const forkRepoSchema = z.object({
  ...scopeShape,
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  intoOrg: z.string().trim().min(1).optional(),
});

export async function forkRepoAction(
  input: z.input<typeof forkRepoSchema>,
): Promise<ActionResult<{ result: RepoForkOutput }>> {
  const parsed = forkRepoSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => forkRepo(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: forkRepoAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to fork repo.") };
  }
}

// ── Branches: create ─────────────────────────────────────────────────────────

const createBranchSchema = z.object({
  ...scopeShape,
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  branch: z.string().trim().min(1, "Name the branch."),
  fromBranch: z.string().trim().min(1).optional(),
});

export async function createBranchAction(
  input: z.input<typeof createBranchSchema>,
): Promise<ActionResult<{ result: RepoBranchCreateOutput }>> {
  const parsed = createBranchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => createBranch(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: createBranchAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to create branch.") };
  }
}

// ── Pull requests: open / get / diff ────────────────────────────────────────

const openPrSchema = z.object({
  ...scopeShape,
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  title: z.string().trim().min(1, "Title the pull request."),
  head: z.string().trim().min(1),
  base: z.string().trim().min(1),
  body: z.string().optional(),
  draft: z.boolean().optional(),
});

export async function openPrAction(
  input: z.input<typeof openPrSchema>,
): Promise<ActionResult<{ result: RepoPrOpenOutput }>> {
  const parsed = openPrSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => openPr(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: openPrAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to open pull request."),
    };
  }
}

const prNumberSchema = z.object({
  ...scopeShape,
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  number: z.number().int().positive(),
});

export async function getPrAction(
  input: z.input<typeof prNumberSchema>,
): Promise<ActionResult<{ result: RepoPrGetOutput }>> {
  const parsed = prNumberSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => getPr(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: getPrAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to load pull request."),
    };
  }
}

export async function getPrDiffAction(
  input: z.input<typeof prNumberSchema>,
): Promise<ActionResult<{ result: RepoPrDiffOutput }>> {
  const parsed = prNumberSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => getPrDiff(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: getPrDiffAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to load pull request diff."),
    };
  }
}

// ── CI status ────────────────────────────────────────────────────────────────

const ciStatusSchema = z.object({
  ...scopeShape,
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  ref: z.string().trim().min(1),
});

export async function getCiStatusAction(
  input: z.input<typeof ciStatusSchema>,
): Promise<ActionResult<{ result: RepoCiStatusOutput }>> {
  const parsed = ciStatusSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => getCiStatus(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: getCiStatusAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to load CI status.") };
  }
}

// ── Files: commit ────────────────────────────────────────────────────────────

const putFileSchema = z.object({
  ...scopeShape,
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  path: z.string().trim().min(1, "Give the file a path."),
  content: z.string(),
  message: z.string().trim().min(1, "Write a commit message."),
  branch: z.string().trim().min(1).optional(),
});

export async function putRepoFileAction(
  input: z.input<typeof putFileSchema>,
): Promise<ActionResult<{ result: RepoFilePutOutput }>> {
  const parsed = putFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => putRepoFile(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: putRepoFileAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to commit file.") };
  }
}

// ── Agent-driven edit → PR ──────────────────────────────────────────────────

const editRepoFileSchema = z.object({
  ...scopeShape,
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  instruction: z
    .string()
    .trim()
    .min(10, "Instruction must be at least 10 characters."),
  baseBranch: z.string().trim().min(1).optional(),
  branchName: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  maxSteps: z.number().int().min(1).max(40).default(12),
  environmentId: z.string().trim().min(1).optional(),
});

export async function editRepoFileAction(
  input: z.input<typeof editRepoFileSchema>,
): Promise<ActionResult<{ result: AgentRepoEditOutput }>> {
  const parsed = editRepoFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => editRepoFile(ctx, rest),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: editRepoFileAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "The coding agent failed to complete this edit."),
    };
  }
}

// ── File locks: list / release ──────────────────────────────────────────────

const listLocksSchema = z.object({
  ...scopeShape,
  path: z.string().trim().min(1).optional(),
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
});

export async function listFileLocksAction(
  input: z.input<typeof listLocksSchema>,
): Promise<ActionResult<{ locks: RepoLock[] }>> {
  const parsed = listLocksSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, ...rest } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  try {
    const locks = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => listFileLocks(ctx, rest),
    );
    return { ok: true, locks };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workbench.repos: listFileLocksAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to load file locks.") };
  }
}

const releaseLockSchema = z.object({
  ...scopeShape,
  lockId: z.string().min(1),
});

export async function releaseFileLockAction(
  input: z.input<typeof releaseLockSchema>,
): Promise<ActionResult<{ released: boolean }>> {
  const parsed = releaseLockSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, lockId } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_ERROR };
  try {
    const out = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => releaseFileLock(ctx, lockId),
    );
    return { ok: true, released: out.released };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, lockId },
      "workbench.repos: releaseFileLockAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to release lock.") };
  }
}
