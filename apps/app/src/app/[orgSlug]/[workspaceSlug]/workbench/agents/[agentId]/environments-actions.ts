"use server";

import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind agent.environment.* + sandbox.template.* + environment.*
// handlers so invoke() can resolve them.
import "@oxagen/handlers/register";
import { agentEnvironmentBind } from "@oxagen/oxagen/contracts/agent.environment.bind";
import { agentEnvironmentUnbind } from "@oxagen/oxagen/contracts/agent.environment.unbind";
import { agentEnvironmentList } from "@oxagen/oxagen/contracts/agent.environment.list";
import { environmentList } from "@oxagen/oxagen/contracts/environment.list";
import { sandboxTemplateList } from "@oxagen/oxagen/contracts/sandbox.template.list";
import type { AgentEnvironmentListOutput } from "@oxagen/oxagen/contracts/agent.environment.list";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { runInTenantScope } from "@oxagen/tenancy";
import { workspace } from "@/lib/routes";

// ── Shared types (mirror the contract outputs) ────────────────────────────────

export type AgentEnvironmentBinding =
  AgentEnvironmentListOutput["bindings"][number];

export interface EnvironmentOption {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
}

export interface TemplateOption {
  id: string;
  environmentId: string;
  name: string;
  slug: string;
  isDefault: boolean;
}

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

interface Scope {
  orgSlug: string;
  workspaceSlug: string;
}

// agent.environment.* + environment.* + sandbox.template.* surface
// ["api","mcp","agent"] (not "app"), so every invoke() below passes
// opts.surface "agent".
const AGENT_SURFACE = { surface: "agent" } as const;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function revalidate(args: Scope & { agentId: string }): void {
  revalidatePath(
    workspace.workbench.agent(
      { orgSlug: args.orgSlug, workspaceSlug: args.workspaceSlug },
      args.agentId,
    ),
  );
}

// ── Reads (any workspace member) ──────────────────────────────────────────────

export async function readAgentBindingsAction(
  args: Scope & { agentId: string },
): Promise<AgentEnvironmentBinding[]> {
  const { ctx, org, ws } = await resolveWorkbenchScope(
    args.orgSlug,
    args.workspaceSlug,
  );
  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const out = (await invoke(
      agentEnvironmentList.name,
      { agentId: args.agentId },
      ctx,
      AGENT_SURFACE,
    )) as { bindings: AgentEnvironmentBinding[] };
    return out.bindings;
  });
}

export async function readEnvironmentOptionsAction(
  args: Scope,
): Promise<EnvironmentOption[]> {
  const { ctx, org, ws } = await resolveWorkbenchScope(
    args.orgSlug,
    args.workspaceSlug,
  );
  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const out = (await invoke(
      environmentList.name,
      {},
      ctx,
      AGENT_SURFACE,
    )) as { environments: EnvironmentOption[] };
    return out.environments;
  });
}

export async function readTemplateOptionsAction(
  args: Scope,
): Promise<TemplateOption[]> {
  const { ctx, org, ws } = await resolveWorkbenchScope(
    args.orgSlug,
    args.workspaceSlug,
  );
  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const out = (await invoke(
      sandboxTemplateList.name,
      {},
      ctx,
      AGENT_SURFACE,
    )) as {
      templates: {
        id: string;
        environmentId: string;
        name: string;
        slug: string;
        isDefault: boolean;
      }[];
    };
    return out.templates.map((t) => ({
      id: t.id,
      environmentId: t.environmentId,
      name: t.name,
      slug: t.slug,
      isDefault: t.isDefault,
    }));
  });
}

// ── Mutations (owner/admin) ───────────────────────────────────────────────────

export async function bindAgentEnvironmentAction(
  args: Scope & {
    agentId: string;
    environmentId: string;
    sandboxTemplateId?: string | null;
    isPrimary?: boolean;
  },
): Promise<ActionResult<{ binding: AgentEnvironmentBinding }>> {
  const { ctx, org, ws, canManage } = await resolveWorkbenchScope(
    args.orgSlug,
    args.workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners or admins can bind agent environments.",
    };
  }
  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    try {
      const out = (await invoke(
        agentEnvironmentBind.name,
        {
          agentId: args.agentId,
          environmentId: args.environmentId,
          sandboxTemplateId: args.sandboxTemplateId ?? null,
          isPrimary: args.isPrimary,
        },
        ctx,
        AGENT_SURFACE,
      )) as { binding: AgentEnvironmentBinding };
      revalidate(args);
      return { ok: true, binding: out.binding };
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err, "Failed to bind environment"),
      };
    }
  });
}

export async function unbindAgentEnvironmentAction(
  args: Scope & { agentId: string; environmentId: string },
): Promise<ActionResult> {
  const { ctx, org, ws, canManage } = await resolveWorkbenchScope(
    args.orgSlug,
    args.workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners or admins can unbind agent environments.",
    };
  }
  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    try {
      await invoke(
        agentEnvironmentUnbind.name,
        { agentId: args.agentId, environmentId: args.environmentId },
        ctx,
        AGENT_SURFACE,
      );
      revalidate(args);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err, "Failed to unbind environment"),
      };
    }
  });
}
