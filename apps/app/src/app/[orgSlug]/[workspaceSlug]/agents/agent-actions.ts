"use server";
/**
 * agent-actions.ts — server actions for Workspace → Agents.
 *
 * Every mutation here goes through the shared `invoke()` kernel against the
 * agent lifecycle capabilities (agent.definition.*, agent.trigger.*,
 * agent.deploy). They are role-gated to workspace owners and admins, mirroring
 * the IAM pattern from prompt-settings-action.ts / models-action.ts exactly:
 *   resolveOrg → resolveWorkspace → assertOrgMember → runInTenantScope →
 *   re-read workspace role server-side (never trust a client flag) → invoke.
 *
 * Inputs are validated against the SHARED Zod schemas from
 * `@oxagen/oxagen/agent-schema` (agentDefinitionConfigSchema, agentTriggerSchema)
 * — no duplicate schema definitions.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler so invoke() can resolve.
import "@oxagen/handlers/register";
import {
  agentDefinitionConfigSchema,
  agentTriggerSchema,
  agentDeploymentStatusSchema,
} from "@oxagen/oxagen/agent-schema";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import type { AgentDefinitionCreateOutput } from "@oxagen/oxagen/contracts/agent.definition.create";
import type { AgentDefinitionUpdateOutput } from "@oxagen/oxagen/contracts/agent.definition.update";
import type { AgentDefinitionPublishOutput } from "@oxagen/oxagen/contracts/agent.definition.publish";
import type { AgentDeployOutput } from "@oxagen/oxagen/contracts/agent.deploy";
import type { AgentTriggerCreateOutput } from "@oxagen/oxagen/contracts/agent.trigger.create";
import type { AgentTriggerUpdateOutput } from "@oxagen/oxagen/contracts/agent.trigger.update";
import type { AgentTriggerDeleteOutput } from "@oxagen/oxagen/contracts/agent.trigger.delete";

// ── Re-exports for client/page consumers ───────────────────────────────────────
export type { AgentDefinitionConfig } from "@oxagen/oxagen/agent-schema";
export type { AgentDefinitionGetOutput } from "@oxagen/oxagen/contracts/agent.definition.get";
export type { AgentDefinitionListOutput } from "@oxagen/oxagen/contracts/agent.definition.list";
export type { AgentTriggerListOutput } from "@oxagen/oxagen/contracts/agent.trigger.list";

// ── Result envelope ─────────────────────────────────────────────────────────────

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

// ── Shared input schemas (built atop the shared agent-schema) ───────────────────

const scopeSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
});

const createSchema = scopeSchema.extend({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case"),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  config: agentDefinitionConfigSchema,
});

const updateSchema = scopeSchema.extend({
  agentId: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  config: agentDefinitionConfigSchema,
});

const publishSchema = scopeSchema.extend({
  agentId: z.string().min(1),
  version: z.number().int().positive().optional(),
});

const deploySchema = scopeSchema.extend({
  agentId: z.string().min(1),
  deploymentStatus: agentDeploymentStatusSchema,
});

const triggerCreateSchema = scopeSchema.extend({
  agentId: z.string().min(1),
  trigger: agentTriggerSchema,
});

const triggerUpdateSchema = scopeSchema.extend({
  triggerId: z.string().min(1),
  trigger: agentTriggerSchema,
});

const triggerDeleteSchema = scopeSchema.extend({
  triggerId: z.string().min(1),
});

export type AgentCreateInput = z.input<typeof createSchema>;
export type AgentUpdateInput = z.input<typeof updateSchema>;
export type AgentPublishInput = z.input<typeof publishSchema>;
export type AgentDeployInput = z.input<typeof deploySchema>;
export type AgentTriggerCreateInput = z.input<typeof triggerCreateSchema>;
export type AgentTriggerUpdateInput = z.input<typeof triggerUpdateSchema>;
export type AgentTriggerDeleteInput = z.input<typeof triggerDeleteSchema>;

// ── Helpers ─────────────────────────────────────────────────────────────────────

function buildCapabilityContext(opts: {
  orgId: string;
  workspaceId: string;
  userId: string;
}) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

function errorResult(err: unknown, fallback: string): { ok: false; error: string; code?: string } {
  const message = err instanceof Error ? err.message : fallback;
  const code =
    err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
  return { ok: false, error: message, code };
}

/**
 * Resolve scope, assert org membership, enter the tenant RLS scope, and
 * re-verify the caller is a workspace owner/admin server-side. Returns an
 * error envelope when the caller is not authorised; otherwise runs `fn` with
 * a capability context bound to the resolved org + workspace.
 */
async function withWriteScope<T>(
  scope: { orgSlug: string; workspaceSlug: string },
  fn: (ctx: ReturnType<typeof buildCapabilityContext>) => Promise<T>,
): Promise<ActionResult<T>> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(scope.orgSlug);
  const ws = await resolveWorkspace(org.id, scope.workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const wsRoleRows = await withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, ws.id),
            eq(schema.workspaceUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    );

    const wsRole = wsRoleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
      return {
        ok: false as const,
        error: "Only workspace owners and admins can manage agents.",
      };
    }

    const ctx = buildCapabilityContext({
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
    });

    try {
      const data = await fn(ctx);
      return { ok: true as const, data };
    } catch (err) {
      return errorResult(err, "Agent operation failed.");
    }
  });
}

function revalidateAgents(scope: { orgSlug: string; workspaceSlug: string }) {
  const routeCtx: Required<ScopeContext> = scope;
  revalidatePath(workspace.agents.root(routeCtx));
}

// ── Actions ──────────────────────────────────────────────────────────────────────

export async function createAgentAction(
  input: AgentCreateInput,
): Promise<ActionResult<AgentDefinitionCreateOutput>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, slug, name, description, config } = parsed.data;

  const result = await withWriteScope({ orgSlug, workspaceSlug }, async (ctx) => {
    return (await invoke(
      "agent.definition.create",
      { slug, name, description, agentType: "custom", config },
      ctx,
      { surface: "agent" },
    )) as AgentDefinitionCreateOutput;
  });

  if (result.ok) revalidateAgents({ orgSlug, workspaceSlug });
  return result;
}

export async function updateAgentAction(
  input: AgentUpdateInput,
): Promise<ActionResult<AgentDefinitionUpdateOutput>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, agentId, name, description, config } = parsed.data;

  const result = await withWriteScope({ orgSlug, workspaceSlug }, async (ctx) => {
    return (await invoke(
      "agent.definition.update",
      { agentId, name, description, config },
      ctx,
      { surface: "agent" },
    )) as AgentDefinitionUpdateOutput;
  });

  if (result.ok) revalidateAgents({ orgSlug, workspaceSlug });
  return result;
}

export async function publishAgentAction(
  input: AgentPublishInput,
): Promise<ActionResult<AgentDefinitionPublishOutput>> {
  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, agentId, version } = parsed.data;

  const result = await withWriteScope({ orgSlug, workspaceSlug }, async (ctx) => {
    return (await invoke(
      "agent.definition.publish",
      version === undefined ? { agentId } : { agentId, version },
      ctx,
      { surface: "agent" },
    )) as AgentDefinitionPublishOutput;
  });

  if (result.ok) revalidateAgents({ orgSlug, workspaceSlug });
  return result;
}

export async function deployAgentAction(
  input: AgentDeployInput,
): Promise<ActionResult<AgentDeployOutput>> {
  const parsed = deploySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, agentId, deploymentStatus } = parsed.data;

  const result = await withWriteScope({ orgSlug, workspaceSlug }, async (ctx) => {
    return (await invoke(
      "agent.deploy",
      { agentId, deploymentStatus },
      ctx,
      { surface: "agent" },
    )) as AgentDeployOutput;
  });

  if (result.ok) revalidateAgents({ orgSlug, workspaceSlug });
  return result;
}

export async function createTriggerAction(
  input: AgentTriggerCreateInput,
): Promise<ActionResult<AgentTriggerCreateOutput>> {
  const parsed = triggerCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, agentId, trigger } = parsed.data;

  const result = await withWriteScope({ orgSlug, workspaceSlug }, async (ctx) => {
    return (await invoke(
      "agent.trigger.create",
      { agentId, trigger },
      ctx,
      { surface: "agent" },
    )) as AgentTriggerCreateOutput;
  });

  if (result.ok) revalidateAgents({ orgSlug, workspaceSlug });
  return result;
}

export async function updateTriggerAction(
  input: AgentTriggerUpdateInput,
): Promise<ActionResult<AgentTriggerUpdateOutput>> {
  const parsed = triggerUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, triggerId, trigger } = parsed.data;

  const result = await withWriteScope({ orgSlug, workspaceSlug }, async (ctx) => {
    return (await invoke(
      "agent.trigger.update",
      { triggerId, trigger },
      ctx,
      { surface: "agent" },
    )) as AgentTriggerUpdateOutput;
  });

  if (result.ok) revalidateAgents({ orgSlug, workspaceSlug });
  return result;
}

export async function deleteTriggerAction(
  input: AgentTriggerDeleteInput,
): Promise<ActionResult<AgentTriggerDeleteOutput>> {
  const parsed = triggerDeleteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, triggerId } = parsed.data;

  const result = await withWriteScope({ orgSlug, workspaceSlug }, async (ctx) => {
    return (await invoke(
      "agent.trigger.delete",
      { triggerId },
      ctx,
      { surface: "agent" },
    )) as AgentTriggerDeleteOutput;
  });

  if (result.ok) revalidateAgents({ orgSlug, workspaceSlug });
  return result;
}
