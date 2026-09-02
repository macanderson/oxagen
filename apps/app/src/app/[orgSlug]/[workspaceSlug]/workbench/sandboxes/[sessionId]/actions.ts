"use server";
/**
 * workbench/sandboxes/[sessionId]/actions.ts — detail-page server actions.
 *
 * These are the file-browser + rename actions for one sandbox. They follow the
 * exact house pattern of `../actions.ts` (start/run/stop):
 *   1. zod safeParse the client payload,
 *   2. resolveWorkbenchScope → session + org + workspace + IAM,
 *   3. gate on `canManage` (workspace Owner/Admin) — apps/app does NOT bootstrap
 *      IAM through invoke(), so this IS the authorization gate; the sandbox
 *      surface treats reads and writes alike as manage-only,
 *   4. runInTenantScope → invoke the capability with surface "agent"
 *      (`list_sandbox_files`/`read_sandbox_file` declare surfaces
 *      ["api","mcp","agent","cli"], never "app"),
 *   5. return a discriminated union { ok: true, … } | { ok: false, error }.
 *
 * The file browser reads the sandbox through a DIRECT capability invoke inside
 * the app's own tenant scope — never a cross-service HTTP hop to the Hono API.
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { workspace } from "@/lib/routes";
import { isSandboxUnavailable } from "@/lib/workbench/sandboxes";

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

/** One file-tree entry — the `list_sandbox_files` output row shape. */
export interface SandboxFileEntry {
  /** Workspace-relative path (relative to the workspace root). */
  path: string;
  kind: "file" | "dir";
  sizeBytes: number;
  /** True when git (in the sandbox) reports this path as gitignored. */
  gitignored?: boolean;
}

/** One file's contents — the `read_sandbox_file` output shape. */
export interface SandboxFileRead {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  sizeBytes: number;
  truncated: boolean;
}

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; unavailable?: boolean };

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ── List files ────────────────────────────────────────────────────────────────

const listFilesSchema = z.object({
  ...scopeShape,
  sessionId: z.string().min(1),
  /** Workspace-relative directory to list; defaults to the workspace root. */
  path: z.string().max(1024).optional(),
  /** Recursion depth (1-5); the capability defaults to 2 when omitted. */
  depth: z.number().int().min(1).max(5).optional(),
});

export async function listSandboxFilesAction(
  input: z.input<typeof listFilesSchema>,
): Promise<ActionResult<{ entries: SandboxFileEntry[] }>> {
  const parsed = listFilesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, sessionId, path, depth } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can browse sandbox files.",
    };
  }
  try {
    const out = (await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        invoke("list_sandbox_files", { sessionId, path, depth }, ctx, {
          surface: "agent",
        }),
    )) as { entries?: SandboxFileEntry[] };
    return { ok: true, entries: out.entries ?? [] };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, sessionId, path },
      "studio.sandboxes: listSandboxFilesAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to list sandbox files."),
      unavailable: isSandboxUnavailable(err),
    };
  }
}

// ── Read a file ─────────────────────────────────────────────────────────────

const readFileSchema = z.object({
  ...scopeShape,
  sessionId: z.string().min(1),
  path: z.string().min(1).max(1024),
  /** Byte cap for the read (the capability defaults to 256 KiB, cap 1 MiB). */
  maxBytes: z.number().int().positive().optional(),
});

export async function readSandboxFileAction(
  input: z.input<typeof readFileSchema>,
): Promise<ActionResult<{ file: SandboxFileRead }>> {
  const parsed = readFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, sessionId, path, maxBytes } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can read sandbox files.",
    };
  }
  try {
    const file = (await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        invoke("read_sandbox_file", { sessionId, path, maxBytes }, ctx, {
          surface: "agent",
        }),
    )) as SandboxFileRead;
    return { ok: true, file };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, sessionId, path },
      "studio.sandboxes: readSandboxFileAction failed",
    );
    return {
      ok: false,
      error: errMessage(err, "Failed to read sandbox file."),
      unavailable: isSandboxUnavailable(err),
    };
  }
}

// ── Rename a sandbox ──────────────────────────────────────────────────────────

const renameSchema = z.object({
  ...scopeShape,
  sessionId: z.string().min(1),
  /** New human-friendly name; trimmed, 1-80 chars (matches the contract). */
  label: z.string().trim().min(1, "Name your sandbox.").max(80),
});

export async function renameSandboxAction(
  input: z.input<typeof renameSchema>,
): Promise<ActionResult<{ label: string }>> {
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
    const out = (await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        invoke("rename_sandbox", { sessionId, label }, ctx, {
          surface: "agent",
        }),
    )) as { label?: string };
    // Refresh the list so the renamed sandbox shows its new name there too.
    revalidatePath(workspace.workbench.sandboxes({ orgSlug, workspaceSlug }));
    return { ok: true, label: out.label ?? label };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, sessionId },
      "studio.sandboxes: renameSandboxAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to rename sandbox.") };
  }
}
