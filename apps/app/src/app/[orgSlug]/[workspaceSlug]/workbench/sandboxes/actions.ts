"use server";
/**
 * workbench/sandboxes/actions.ts — server actions for the Sandboxes surface.
 *
 * Every mutating action (start / run / stop / rename) follows the house pattern:
 *   1. zod safeParse the client payload (never trust the client),
 *   2. resolveWorkbenchScope → session + org + workspace + IAM,
 *   3. gate on `canManage` (workspace Owner/Admin) — apps/app does NOT bootstrap
 *      IAM through invoke(), so this IS the authorization gate. Running shell in
 *      a sandbox is high-risk, so mutations (and the log read) require manage
 *      rights,
 *   4. call the lib/workbench/sandboxes helper (invoke with surface "agent"),
 *   5. return a discriminated union { ok: true, … } | { ok: false, error }.
 *
 * `refreshSandboxesAction` is the one exception to step 3 — it's a read of the
 * session registry only (no shell access), so it mirrors the page's own
 * gating (any resolved workspace member) to let the list's live-tail poll run
 * for every viewer, not just managers.
 *
 * `run_sandbox_command` is invoked from here rather than the client so the
 * SandboxTerminal stays pure UI (it receives an injected runner).
 */
import "@oxagen/handlers/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { workspace } from "@/lib/routes";
import {
  startSandbox,
  runSandboxCommand,
  stopSandbox,
  listSandboxes,
  listSandboxLogs,
  renameSandbox,
  isSandboxUnavailable,
  type SandboxExecResult,
  type SandboxStartResult,
  type SandboxLogLine,
  type SandboxSummary,
  type SandboxRenameResult,
} from "@/lib/workbench/sandboxes";
import { templateById } from "@/components/sandbox/warm-up-templates";
import {
  PACKAGE_MANAGERS,
  isValidPackageToken,
} from "@/components/sandbox/sandbox-runtimes";

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; unavailable?: boolean };

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ── Start / warm a sandbox ────────────────────────────────────────────────────

/**
 * Turn a human name into a readable, unique reuse key: `sbx_<slug>_<rand8>`. The
 * slug makes the key recognizable in logs/registry; the random suffix keeps it
 * unique so two same-named warms don't collide on the (workspace, sessionKey)
 * uniqueness constraint. Bounded to stay well under the 200-char key limit.
 */
function seedSessionKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `sbx_${slug || "sandbox"}_${crypto.randomUUID().slice(0, 8)}`;
}

/** A single repo to clone into `/work/<repo>` while the sandbox provisions. */
const repoRefSchema = z.object({
  owner: z.string().trim().min(1).max(200),
  repo: z.string().trim().min(1).max(200),
  /** Defaults to the repo's default branch server-side when omitted. */
  branch: z.string().trim().min(1).max(200).optional(),
});

/**
 * Packages to install once at warm time, grouped by manager. Names are
 * re-validated to a safe charset server-side (defense in depth) before they can
 * reach the composed shell command — only applied to the built-in presets.
 */
const setupPackageGroupSchema = z.object({
  manager: z.enum(["npm", "pip", "apt"]),
  names: z.array(z.string().trim().min(1).max(214)).max(50),
});

const startSchema = z.object({
  ...scopeShape,
  /** Required human name — every warmed sandbox is named so it's identifiable. */
  name: z.string().trim().min(1, "Name your sandbox.").max(80),
  /**
   * Either a built-in preset id (oxagen-agent | node | python | blank) or a
   * saved sandbox-template public id (`sbx_…`). Saved templates govern the
   * image/runtime/resources server-side; presets carry an image + one-time
   * setupCmd.
   */
  templateId: z.string().min(1),
  /** Optional explicit reuse key; otherwise seeded from the name. */
  sessionKey: z.string().min(1).max(200).optional(),
  /** As many repos as the caller wants pre-cloned, capped well below any driver limit. */
  repos: z.array(repoRefSchema).max(8).optional(),
  /** Optional warm-time package installs (preset path only). */
  setupPackages: z.array(setupPackageGroupSchema).max(3).optional(),
});

/**
 * Compose the `&&`-chained install commands for the requested package groups,
 * rejecting any token that isn't a valid package name so nothing shell-active
 * can be smuggled into the setup command. Returns the install segments (may be
 * empty) or throws with a clear message on the first invalid token.
 */
function composeSetupInstalls(
  groups: z.infer<typeof setupPackageGroupSchema>[] | undefined,
): string[] {
  if (!groups || groups.length === 0) return [];
  const steps: string[] = [];
  for (const group of groups) {
    const names = group.names.map((n) => n.trim()).filter((n) => n.length > 0);
    if (names.length === 0) continue;
    const invalid = names.filter((n) => !isValidPackageToken(n));
    if (invalid.length > 0) {
      throw new Error(`Invalid package name: ${invalid.join(", ")}`);
    }
    steps.push(PACKAGE_MANAGERS[group.manager].install(names));
  }
  return steps;
}

export async function startSandboxAction(
  input: z.input<typeof startSchema>,
): Promise<ActionResult<{ sandbox: SandboxStartResult }>> {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const {
    orgSlug,
    workspaceSlug,
    name,
    templateId,
    sessionKey,
    repos,
    setupPackages,
  } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can start sandboxes.",
    };
  }
  // A stable key makes the sandbox reusable/warm across turns; seed one from the
  // name when the caller doesn't supply an explicit key.
  const key = sessionKey ?? seedSessionKey(name);

  // Saved sandbox templates carry a `sbx_…` public id; built-in presets use a
  // bare slug. A saved template governs provider/runtime/resources server-side,
  // so we pass its id through and let the base image default.
  const isSavedTemplate = templateId.startsWith("sbx_");

  let installSteps: string[];
  try {
    // Warm-time package installs apply to presets only; a saved template owns
    // its own setup. Validate + compose (throws on an invalid token).
    installSteps = isSavedTemplate ? [] : composeSetupInstalls(setupPackages);
  } catch (err) {
    return { ok: false, error: errMessage(err, "Invalid package selection.") };
  }

  const startInput = isSavedTemplate
    ? {
        label: name,
        sessionKey: key,
        sandboxTemplateId: templateId,
        network: "allow" as const,
        repos,
      }
    : (() => {
        const template = templateById(templateId);
        // Preset setup first, then the requested installs — both run once at
        // create time (the handler runs the whole chain in the workspace root).
        const setupParts = [
          template.setupCmd.length > 0 ? template.setupCmd : "",
          ...installSteps,
        ].filter((s) => s.length > 0);
        return {
          image: template.image,
          label: name,
          sessionKey: key,
          setupCmd: setupParts.length > 0 ? setupParts.join(" && ") : undefined,
          network: "allow" as const,
          repos,
        };
      })();

  try {
    const sandbox = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => startSandbox(ctx, startInput),
    );
    revalidatePath(workspace.workbench.sandboxes({ orgSlug, workspaceSlug }));
    return { ok: true, sandbox };
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        templateId,
        sessionKey: key,
      },
      "studio.sandboxes: startSandboxAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to start sandbox."),
      unavailable: isSandboxUnavailable(err),
    };
  }
}

// ── Run a command ─────────────────────────────────────────────────────────────

const runSchema = z.object({
  ...scopeShape,
  sessionId: z.string().min(1),
  command: z.string().min(1).max(100_000),
  // Prior working directory, threaded back from the terminal so `cd` persists
  // across commands. Optional — the first command in a session omits it.
  cwd: z.string().min(1).max(4_096).optional(),
});

export async function runSandboxCommandAction(
  input: z.input<typeof runSchema>,
): Promise<ActionResult<{ result: SandboxExecResult }>> {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, sessionId, command, cwd } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can run commands.",
    };
  }
  try {
    const result = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => runSandboxCommand(ctx, { sessionId, command, cwd }),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, sessionId },
      "studio.sandboxes: runSandboxCommandAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Command failed to run."),
      unavailable: isSandboxUnavailable(err),
    };
  }
}

// ── List output logs ──────────────────────────────────────────────────────────

const listLogsSchema = z.object({
  ...scopeShape,
  sessionId: z.string().min(1),
  /** Omit for the debug view (everything); "normal" for program output only. */
  level: z.enum(["normal", "debug"]).optional(),
  limit: z.number().int().positive().max(5_000).optional(),
});

export async function listSandboxLogsAction(
  input: z.input<typeof listLogsSchema>,
): Promise<ActionResult<{ lines: SandboxLogLine[] }>> {
  const parsed = listLogsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, sessionId, level, limit } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can view sandbox logs.",
    };
  }
  try {
    const lines = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => listSandboxLogs(ctx, { sessionId, level, limit }),
    );
    return { ok: true, lines };
  } catch (err) {
    return {
      ok: false,
      error: errMessage(err, "Failed to load sandbox logs."),
      unavailable: isSandboxUnavailable(err),
    };
  }
}

// ── Stop a sandbox ────────────────────────────────────────────────────────────

const stopSchema = z.object({ ...scopeShape, sessionId: z.string().min(1) });

export async function stopSandboxAction(
  input: z.input<typeof stopSchema>,
): Promise<ActionResult<{ stopped: boolean }>> {
  const parsed = stopSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, sessionId } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can stop sandboxes.",
    };
  }
  try {
    const out = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => stopSandbox(ctx, sessionId),
    );
    revalidatePath(workspace.workbench.sandboxes({ orgSlug, workspaceSlug }));
    return { ok: true, stopped: out.stopped };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, sessionId },
      "studio.sandboxes: stopSandboxAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to stop sandbox.") };
  }
}

// ── Rename a sandbox ──────────────────────────────────────────────────────────

const renameSchema = z.object({
  ...scopeShape,
  sessionId: z.string().min(1),
  /** The list's primary identifier — a bare sbx_ id is never shown as a label. */
  label: z.string().trim().min(1, "Name your sandbox.").max(80),
});

export async function renameSandboxAction(
  input: z.input<typeof renameSchema>,
): Promise<ActionResult<{ sandbox: SandboxRenameResult }>> {
  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, sessionId, label } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can rename sandboxes.",
    };
  }
  try {
    const sandbox = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => renameSandbox(ctx, { sessionId, label }),
    );
    revalidatePath(workspace.workbench.sandboxes({ orgSlug, workspaceSlug }));
    return { ok: true, sandbox };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, sessionId },
      "studio.sandboxes: renameSandboxAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to rename sandbox.") };
  }
}

// ── Refresh the list (client polling) ─────────────────────────────────────────

const refreshSchema = z.object({
  ...scopeShape,
  /** true ⇒ running|idle only, live-reconciled against the provider. */
  activeOnly: z.boolean().optional(),
});

/**
 * Re-reads the session list for the client's live-tail poll and the "Show
 * inactive" toggle. Read-only, so it mirrors the page's own gating (any
 * resolved, org-member workspace scope) rather than the manage-only gate the
 * mutating actions above use.
 */
export async function refreshSandboxesAction(
  input: z.input<typeof refreshSchema>,
): Promise<ActionResult<{ sandboxes: SandboxSummary[] }>> {
  const parsed = refreshSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, activeOnly } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  try {
    const sandboxes = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => listSandboxes(ctx, { activeOnly }),
    );
    return { ok: true, sandboxes };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "studio.sandboxes: refreshSandboxesAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to refresh sandboxes."),
      unavailable: isSandboxUnavailable(err),
    };
  }
}
