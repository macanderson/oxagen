"use server";
/**
 * skill-actions.ts — server actions for Workspace → Workbench → Skills.
 *
 * All operations delegate to skill lifecycle contracts (skill.create,
 * skill.workspace.*, skill.version.*, skill.export, skill.metrics.read).
 * Auth/scope resolution goes through `resolveWorkbenchScope` — apps/app does
 * not bootstrap the IAM kernel (see CLAUDE.md gotcha), so every server
 * surface must gate explicitly.
 *
 * These invoke() calls deliberately DO NOT pass { surface: "agent" }. The skill
 * capabilities are exposed on ["api","mcp"] (some also "agent"); asserting a
 * surface the contract doesn't list makes the kernel throw surface_denied. The
 * app is a trusted server caller (ctx.surface === "app") and omits opts.surface
 * so no surface allowlist is enforced — matching lib/workbench/equip-sources.ts.
 *
 * Adapted from settings/skills/skill-actions.ts (same contracts, same
 * shapes) — the only changes are the route target (workbench, not settings)
 * and the shared `resolveWorkbenchScope` helper, plus the new `createSkillAction`.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import type { SkillVersionUploadOutput } from "@oxagen/oxagen/contracts/skill.version.upload";
import type { SkillExportOutput } from "@oxagen/oxagen/contracts/skill.export";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { resolveAgentToolsManager } from "@/lib/agent-tools/authz";

// ── Helpers ───────────────────────────────────────────────────────────────────

function skillsPath(ctx: Required<ScopeContext>): string {
  return workspace.workbench.tools.skills(ctx);
}

function revalidateSkill(
  routeCtx: Required<ScopeContext>,
  skillSlug: string,
): void {
  revalidatePath(skillsPath(routeCtx));
  revalidatePath(workspace.workbench.tools.skill(routeCtx, skillSlug));
}

// ── installSkill ──────────────────────────────────────────────────────────────

const InstallSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
});

export async function installSkill(
  input: z.infer<typeof InstallSkillSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = InstallSkillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth.scope;

  try {
    // install_skill takes the builtin template slug to copy (contract:
    // skill.workspace.install — `slug`, not `skillSlug`).
    await invoke("install_skill", { slug: parsed.data.skillSlug }, ctx);
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(skillsPath(routeCtx));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Install failed",
    };
  }
}

// ── editSkill (create new version from content) ───────────────────────────────

const EditSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
  content: z.string().min(1).max(500_000),
  commitMessage: z.string().max(500).optional(),
});

export async function editSkill(
  input: z.infer<typeof EditSkillSchema>,
): Promise<{
  ok: boolean;
  versionId?: string;
  version?: string;
  versionNumber?: number;
  error?: string;
}> {
  const parsed = EditSkillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth.scope;

  try {
    // activate: false — a saved edit is a draft version until the user
    // explicitly confirms pinning it as the workspace default (the detail
    // panel asks right after save). Mirrors the agent draft→publish model.
    const out = (await invoke(
      "upload_skill_version",
      {
        skill_id: parsed.data.skillSlug,
        body: parsed.data.content,
        change_summary: parsed.data.commitMessage,
        activate: false,
      },
      ctx,
    )) as SkillVersionUploadOutput;
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidateSkill(routeCtx, parsed.data.skillSlug);
    return {
      ok: true,
      versionId: out.version_id,
      version: `v${out.version_number}`,
      versionNumber: out.version_number,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Edit failed",
    };
  }
}

// ── activateVersion ───────────────────────────────────────────────────────────

const ActivateVersionSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
  versionNumber: z.number().int().min(1),
});

export async function activateVersion(
  input: z.infer<typeof ActivateVersionSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = ActivateVersionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth.scope;

  try {
    await invoke(
      "activate_skill_version",
      {
        skillId: parsed.data.skillSlug,
        versionNumber: parsed.data.versionNumber,
      },
      ctx,
    );
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidateSkill(routeCtx, parsed.data.skillSlug);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Activate failed",
    };
  }
}

// ── exportSkill ───────────────────────────────────────────────────────────────

const ExportSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  skillSlug: z.string().min(1),
  versionNumber: z.number().int().min(1).optional(),
});

export async function exportSkill(
  input: z.infer<typeof ExportSkillSchema>,
): Promise<{
  ok: boolean;
  content?: string;
  filename?: string;
  error?: string;
}> {
  const parsed = ExportSkillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  // Read is allowed for all workspace members — no canManage check here.

  try {
    const out = (await invoke(
      "export_skill",
      {
        skillId: parsed.data.skillSlug,
        versionNumber: parsed.data.versionNumber,
      },
      ctx,
    )) as SkillExportOutput;
    return { ok: true, content: out.content, filename: out.filename };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Export failed",
    };
  }
}

// ── draftSkillAction ──────────────────────────────────────────────────────────
//
// AI-assisted setup, step 1: the user describes the skill in natural language
// and skill.draft synthesises the full configuration (display name, slug,
// description, weight, body) WITHOUT persisting anything. The wizard presents
// the draft as a prefilled form; the confirmed result saves via
// createSkillAction → skill.create.

const DraftSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  prompt: z.string().min(10).max(4000),
});

export interface SkillDraftResult {
  displayName: string;
  slug: string;
  description: string;
  weight: "low" | "high" | "critical";
  category?: string;
  body: string;
}

export async function draftSkillAction(
  input: z.infer<typeof DraftSkillSchema>,
): Promise<
  { ok: true; draft: SkillDraftResult } | { ok: false; error: string }
> {
  const parsed = DraftSkillSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { orgSlug, workspaceSlug, prompt } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth.scope;

  try {
    const out = await invoke("draft_skill", { prompt }, ctx);
    const typed = out as { draft: SkillDraftResult };
    return { ok: true, draft: typed.draft };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Draft failed",
    };
  }
}

// ── createSkillAction ─────────────────────────────────────────────────────────
//
// Composes the YAML frontmatter that the skill loader expects (see
// packages/skills/src/types.ts skillFrontmatterSchema — name/description
// required, metadata.weight optional low|high|critical) around the user's
// markdown body, then calls skill.create. skill.create itself stores `body`
// verbatim (no server-side frontmatter validation — see
// packages/handlers/src/skill.create.ts) so composing here is the only place
// this shape gets applied.

const CreateSkillSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Slug must be kebab-case (a-z, 0-9, hyphens)"),
  description: z.string().min(1).max(500),
  weight: z.enum(["low", "high", "critical"]),
  body: z.string().min(1).max(32_000),
  activate: z.boolean(),
});

const MAX_SKILL_MD_LENGTH = 32_000;

/** YAML-safe double-quoted scalar (JSON strings are valid YAML strings). */
function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

export async function createSkillAction(
  input: z.infer<typeof CreateSkillSchema>,
): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const parsed = CreateSkillSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const {
    orgSlug,
    workspaceSlug,
    name,
    slug,
    description,
    weight,
    body,
    activate,
  } = parsed.data;
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth.scope;

  const frontmatter = [
    "---",
    `name: ${yamlQuote(slug)}`,
    `description: ${yamlQuote(description)}`,
    "metadata:",
    `  weight: ${weight}`,
    "---",
    "",
  ].join("\n");
  const fullBody = `${frontmatter}\n${body}`;

  if (fullBody.length > MAX_SKILL_MD_LENGTH) {
    return {
      ok: false,
      error: `Skill content is too long (${fullBody.length} chars incl. frontmatter; max ${MAX_SKILL_MD_LENGTH}).`,
    };
  }

  try {
    const out = await invoke(
      "create_skill",
      { name, slug, description, body: fullBody, activate },
      ctx,
    );
    const typed = out as { slug: string; created: boolean };
    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(skillsPath(routeCtx));
    revalidatePath(workspace.workbench.tools.skill(routeCtx, typed.slug));
    return { ok: true, slug: typed.slug };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Create failed",
    };
  }
}
