"use server";
/**
 * workbench/agents/actions.ts — server actions for the Agent Builder.
 *
 * create / update / publish / deploy an agent definition. Every action:
 *   1. zod safeParse's the client payload (never trust the client),
 *   2. resolves the Workbench scope + IAM via resolveWorkbenchScope,
 *   3. gates the mutation on `canManage` (workspace Owner/Admin) — apps/app does
 *      NOT bootstrap IAM through invoke(), so this is THE authorization gate,
 *   4. calls the corresponding lib/workbench/agents helper,
 *   5. revalidates the Workbench Agents surface,
 *   6. returns a discriminated union { ok: true, … } | { ok: false, error }.
 *
 * The house form pattern: plain payload in, union out — no useActionState.
 */
import "@oxagen/handlers/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  graphAccessSchema,
  agentToolSchema,
} from "@oxagen/oxagen/agent-schema";
import { logger } from "@oxagen/handlers/logger";
import { avatarUrlSchema } from "@oxagen/oxagen/avatar";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import type { WorkbenchCtx } from "@/lib/workbench/scope";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import {
  createAgent,
  updateAgent,
  publishAgent,
  deployAgent,
  suggestAgentDefinition,
  summarizeAgent,
  type AgentSuggestion,
  type AgentRecommendation,
  type AgentSuggestedRole,
} from "@/lib/workbench/agents";
import {
  assignAgentRole,
  revokeAgentRole,
  isCeilingError,
} from "@/lib/workbench/agent-roles";

// ── Shared shapes ─────────────────────────────────────────────────────────────

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

// The versioned config body. Mirrors agentDefinitionConfigSchema; agentTools
// defaults to [] so a minimal agent (identity + graph) is valid.
const configSchema = z.object({
  graph: graphAccessSchema,
  agentTools: z.array(agentToolSchema).default([]),
  instructions: z.string().optional(),
});

const createSchema = z.object({
  ...scopeShape,
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case"),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  // https:// URL or "avatar:v1:<json>" designed-avatar string; omit to leave unset.
  avatarUrl: avatarUrlSchema.optional(),
  agentType: z.string().min(1),
  config: configSchema,
});

const updateSchema = z.object({
  ...scopeShape,
  agentId: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  // Omit = unchanged, a value = set, null = clear the avatar.
  avatarUrl: avatarUrlSchema.nullable().optional(),
  agentType: z.string().min(1).optional(),
  config: configSchema,
});

const publishSchema = z.object({
  ...scopeShape,
  agentId: z.string().min(1),
  version: z.number().int().positive().optional(),
});

const deploySchema = z.object({
  ...scopeShape,
  agentId: z.string().min(1),
  deploymentStatus: z.enum(["inactive", "active"]),
});

// AI-assisted setup. Mirrors agent.definition.suggest's input: a plain-language
// description plus an optional preferred slug. Nothing is persisted here, so no
// canManage-gated write follows — but the gate still applies, since generating a
// suggestion reads workspace skills/ontologies and spends model budget.
const suggestSchema = z.object({
  ...scopeShape,
  description: z
    .string()
    .min(10, "Describe the agent in at least 10 characters")
    .max(4000),
  nameHint: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug hint must be lowercase kebab-case")
    .optional(),
});

// Role assignment (Agent RBAC Phase 5a). One action covers the picker's whole
// save semantics: assign the selected role, then (only after the assign
// succeeded) revoke the previously-held role so a rejected assign — delegation
// ceiling, tier gate — leaves the old role intact rather than leaving the
// agent role-less.
const assignRoleSchema = z.object({
  ...scopeShape,
  agentId: z.string().min(1),
  roleName: z.string().min(1),
  previousRoleName: z.string().min(1).optional(),
});

export type CreateAgentActionInput = z.input<typeof createSchema>;
export type UpdateAgentActionInput = z.input<typeof updateSchema>;
export type AssignAgentRoleActionInput = z.input<typeof assignRoleSchema>;
export type PublishAgentActionInput = z.input<typeof publishSchema>;
export type DeployAgentActionInput = z.input<typeof deploySchema>;
export type SuggestAgentActionInput = z.input<typeof suggestSchema>;

export type AgentActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const MANAGE_DENIED =
  "Only workspace owners and admins can build or change agents.";

function revalidateAgents(orgSlug: string, workspaceSlug: string): void {
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
  revalidatePath(workspace.workbench.agents(routeCtx));
}

// Regenerate an agent's LLM summary after a save, fail-open: a summary is a
// nice-to-have blurb, so a model hiccup must never fail the create/update the
// user actually asked for. Forced so the summary always reflects the just-saved
// config (create → v1, update → vN+1 both advance the config checksum anyway).
async function regenerateSummarySafe(
  ctx: WorkbenchCtx,
  agentId: string,
): Promise<void> {
  try {
    await summarizeAgent(ctx, agentId, true);
  } catch {
    // swallow — the summary can be regenerated later (e.g. by the list page).
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createAgentAction(
  input: CreateAgentActionInput,
): Promise<
  AgentActionResult<{ agentId: string; publicId: string; slug: string }>
> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const {
    orgSlug,
    workspaceSlug,
    slug,
    name,
    description,
    avatarUrl,
    agentType,
    config,
  } = parsed.data;

  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const out = await createAgent(ctx, {
      slug,
      name,
      description,
      avatarUrl,
      agentType,
      config,
    });
    // Fire the summary regeneration off the just-created agent (fail-open).
    await regenerateSummarySafe(ctx, out.publicId);
    revalidateAgents(orgSlug, workspaceSlug);
    return {
      ok: true,
      agentId: out.publicId,
      publicId: out.publicId,
      slug: out.slug,
    };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, slug },
      "studio.agents: createAgentAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create the agent.",
    };
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateAgentAction(
  input: UpdateAgentActionInput,
): Promise<AgentActionResult<{ version: number; isPublished: boolean }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const {
    orgSlug,
    workspaceSlug,
    agentId,
    name,
    description,
    avatarUrl,
    agentType,
    config,
  } = parsed.data;

  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const out = await updateAgent(ctx, {
      agentId,
      name,
      description,
      avatarUrl,
      agentType,
      config,
    });
    // Regenerate the summary against the just-saved config (fail-open).
    await regenerateSummarySafe(ctx, agentId);
    revalidateAgents(orgSlug, workspaceSlug);
    return { ok: true, version: out.version, isPublished: out.isPublished };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, agentId },
      "studio.agents: updateAgentAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update the agent.",
    };
  }
}

// ── Publish ───────────────────────────────────────────────────────────────────

export async function publishAgentAction(
  input: PublishAgentActionInput,
): Promise<AgentActionResult<{ version: number }>> {
  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, agentId, version } = parsed.data;

  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const out = await publishAgent(ctx, agentId, version);
    revalidateAgents(orgSlug, workspaceSlug);
    return { ok: true, version: out.version };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, agentId },
      "studio.agents: publishAgentAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to publish the agent.",
    };
  }
}

// ── Deploy ────────────────────────────────────────────────────────────────────

export async function deployAgentAction(
  input: DeployAgentActionInput,
): Promise<AgentActionResult<{ deploymentStatus: "inactive" | "active" }>> {
  const parsed = deploySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, agentId, deploymentStatus } = parsed.data;

  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const out = await deployAgent(ctx, agentId, deploymentStatus);
    revalidateAgents(orgSlug, workspaceSlug);
    return { ok: true, deploymentStatus: out.deploymentStatus };
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId,
        deploymentStatus,
      },
      "studio.agents: deployAgentAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to deploy the agent.",
    };
  }
}

// ── Suggest (AI-assisted setup) ─────────────────────────────────────────────────

export async function suggestAgentAction(
  input: SuggestAgentActionInput,
): Promise<
  AgentActionResult<{
    suggestion: AgentSuggestion;
    rationale: string;
    warnings: string[];
    // Tools the agent SHOULD have that are not yet available in the workspace
    // (catalog MCP servers, disabled skills). Never in suggestion.config
    // .agentTools — the caller connects/enables these first, then equips them.
    recommendations: AgentRecommendation[];
    // The narrowest system agent role that can still run the draft (Agent RBAC
    // Phase 5b), with its provenance line. Undefined when the contract omitted
    // it — the builder then falls back to "Agent Contributor". Advisory: the
    // picker pre-selects it, and assign_agent_role stays the authority.
    suggestedRole?: AgentSuggestedRole;
  }>
> {
  const parsed = suggestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, description, nameHint } = parsed.data;

  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const out = await suggestAgentDefinition(ctx, { description, nameHint });
    return {
      ok: true,
      suggestion: out.suggestion,
      rationale: out.rationale,
      warnings: out.warnings,
      recommendations: out.recommendations,
      ...(out.suggestedRole !== undefined
        ? { suggestedRole: out.suggestedRole }
        : {}),
    };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "studio.agents: suggestAgentAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to generate a suggestion.",
    };
  }
}

// ── Role assignment (Agent RBAC Phase 5a) ─────────────────────────────────────

/**
 * Failure carries the handler's stable error code where one exists so the
 * client can render a designed treatment per code (quality gate: never
 * collapse distinct failures into "Something went wrong"):
 *   - `agent_role_ceiling_exceeded` + the offending capabilities,
 *   - any other typed code passed through verbatim.
 */
export type AssignAgentRoleActionResult =
  | { ok: true; roleName: string; alreadyAssigned: boolean }
  | { ok: false; error: string; code?: string; capabilities?: string[] };

export async function assignAgentRoleAction(
  input: AssignAgentRoleActionInput,
): Promise<AssignAgentRoleActionResult> {
  const parsed = assignRoleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, agentId, roleName, previousRoleName } =
    parsed.data;

  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const out = await assignAgentRole(ctx, agentId, roleName);

    // Only after the assign landed: detach the previous role so the picker's
    // single-role model holds. A failed revoke is surfaced (not swallowed) —
    // the agent would otherwise hold both roles and resolve more permissively.
    if (previousRoleName && previousRoleName !== roleName) {
      await revokeAgentRole(ctx, agentId, previousRoleName);
    }

    revalidateAgents(orgSlug, workspaceSlug);
    return {
      ok: true,
      roleName: out.roleName,
      alreadyAssigned: out.alreadyAssigned,
    };
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId,
        roleName,
      },
      "studio.agents: assignAgentRoleAction failed",
    );
    if (isCeilingError(err)) {
      return {
        ok: false,
        error: err.message,
        code: err.code,
        capabilities: [...err.capabilities],
      };
    }
    const code =
      typeof err === "object" &&
      err !== null &&
      typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : undefined;
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to assign the role.",
      ...(code !== undefined ? { code } : {}),
    };
  }
}
