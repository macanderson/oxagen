"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler (incl. sandbox.template.*)
// so invoke() can resolve them. Must be in effect before any invoke() below.
import "@oxagen/handlers/register";
import { sandboxTemplateCreate } from "@oxagen/oxagen/contracts/sandbox.template.create";
import { sandboxTemplateList } from "@oxagen/oxagen/contracts/sandbox.template.list";
import { sandboxTemplateUpdate } from "@oxagen/oxagen/contracts/sandbox.template.update";
import { sandboxTemplateDelete } from "@oxagen/oxagen/contracts/sandbox.template.delete";
import { sandboxTemplateSetDefault } from "@oxagen/oxagen/contracts/sandbox.template.set_default";
import { sandboxTemplateSetTools } from "@oxagen/oxagen/contracts/sandbox.template.set_tools";
import { sandboxTemplateExport } from "@oxagen/oxagen/contracts/sandbox.template.export";
import { sandboxTemplateImport } from "@oxagen/oxagen/contracts/sandbox.template.import";
import type { SandboxTemplateCreateOutput } from "@oxagen/oxagen/contracts/sandbox.template.create";
import type {
  SandboxProvider,
  SandboxResources,
  SandboxNetwork,
  SandboxSecretSelection,
  SandboxLiteralEnv,
  SandboxTemplatePackages,
  SandboxTemplateTool,
  SandboxToolKind,
  SandboxTemplateManifest,
} from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { buildWorkbenchCtx } from "@/lib/workbench/scope";
import { loadEquipSources } from "@/lib/workbench/equip-sources";
import { workspace as routes } from "@/lib/routes";

// ── Shared types (mirror the contract outputs) ────────────────────────────────

/** Full template shape returned by every sandbox.template.* read/write. */
export type SandboxTemplateSummary = SandboxTemplateCreateOutput["template"];

/** A tool suggestion for the picker, drawn from the workspace's installed pools. */
export interface ToolSourceOption {
  kind: SandboxToolKind;
  ref: string;
  label: string;
}

/** Editable payload the create/edit dialog submits. */
export interface TemplateFormInput {
  environmentId: string;
  name: string;
  slug: string;
  description?: string | null;
  provider?: SandboxProvider;
  runtime?: string | null;
  resources?: SandboxResources;
  network?: SandboxNetwork;
  secretSelection?: SandboxSecretSelection;
  literalEnv?: SandboxLiteralEnv;
  packages?: SandboxTemplatePackages;
  tools?: SandboxTemplateTool[];
  setAsDefault?: boolean;
}

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// ── Scope + role resolution (mirrors ./actions.ts) ────────────────────────────

interface Scope {
  orgId: string;
  workspaceId: string;
  userId: string;
}

async function resolveScope(
  orgSlug: string,
  workspaceSlug: string,
): Promise<Scope> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);
  return { orgId: org.id, workspaceId: ws.id, userId: session.user.id };
}

/**
 * Re-read the caller's workspace role server-side — apps/app does NOT enforce
 * IAM via invoke(), so this is the gate. Owner/Admin may manage templates.
 */
async function isManager(scope: Scope): Promise<boolean> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({ role: schema.workspaceUsers.role })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, scope.workspaceId),
          eq(schema.workspaceUsers.userId, scope.userId),
        ),
      )
      .limit(1),
  );
  const role = (rows[0]?.role ?? "").toLowerCase();
  return role === "owner" || role === "admin";
}

/**
 * The transport-level context every sandbox.template.* invoke() carries.
 * `surface: "app"` labels where the call came FROM; the kernel's surface
 * allowlist is checked against `opts.surface`, which every call site below
 * sets to "agent" because the sandbox.template.* contracts expose
 * ["api","mcp","agent"] and not "app" — same precedent as the vault actions.
 */
function templateCtx(scope: Scope) {
  return {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function revalidate(args: { orgSlug: string; workspaceSlug: string }): void {
  revalidatePath(routes.workbench.sandboxes(args));
}

// ── Reads (any ORG member — `resolveScope` asserts org, not workspace,
//    membership; only the mutation gate below reads the workspace role) ───────

export async function readTemplatesAction(args: {
  orgSlug: string;
  workspaceSlug: string;
}): Promise<SandboxTemplateSummary[]> {
  const scope = await resolveScope(args.orgSlug, args.workspaceSlug);
  return runInTenantScope(
    { orgId: scope.orgId, workspaceId: scope.workspaceId },
    async () => {
      const out = (await invoke(
        sandboxTemplateList.name,
        {},
        templateCtx(scope),
        {
          surface: "agent",
        },
      )) as { templates: SandboxTemplateSummary[] };
      return out.templates;
    },
  );
}

/**
 * Flatten the workspace's installed skills, capabilities, and MCP servers into
 * tool suggestions for the template's tools picker. Degrades to [] on failure —
 * the picker still allows manual kind+ref entry.
 */
export async function readToolSourcesAction(args: {
  orgSlug: string;
  workspaceSlug: string;
}): Promise<ToolSourceOption[]> {
  const scope = await resolveScope(args.orgSlug, args.workspaceSlug);
  return runInTenantScope(
    { orgId: scope.orgId, workspaceId: scope.workspaceId },
    async () => {
      try {
        const ctx = buildWorkbenchCtx({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
        });
        const sources = await loadEquipSources(
          ctx,
          scope.orgId,
          scope.workspaceId,
        );
        const options: ToolSourceOption[] = [];
        for (const s of sources.skills) {
          options.push({ kind: "agent_skill", ref: s.ref, label: s.name });
        }
        for (const t of sources.tools) {
          options.push({ kind: "capability", ref: t.name, label: t.name });
        }
        for (const m of sources.mcp) {
          options.push({
            kind: "mcp_server",
            ref: m.ref,
            label: m.title ?? m.name,
          });
        }
        return options;
      } catch {
        return [];
      }
    },
  );
}

// ── Mutations (owner/admin) ───────────────────────────────────────────────────

async function asManager<T>(
  args: { orgSlug: string; workspaceSlug: string },
  fn: (scope: Scope) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const scope = await resolveScope(args.orgSlug, args.workspaceSlug);
  return runInTenantScope(
    { orgId: scope.orgId, workspaceId: scope.workspaceId },
    async () => {
      if (!(await isManager(scope))) {
        return {
          ok: false,
          error:
            "Only workspace owners or admins can manage sandbox templates.",
        };
      }
      return fn(scope);
    },
  );
}

export async function createTemplateAction(
  args: { orgSlug: string; workspaceSlug: string } & TemplateFormInput,
): Promise<ActionResult<{ template: SandboxTemplateSummary }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        sandboxTemplateCreate.name,
        {
          environmentId: args.environmentId,
          name: args.name,
          slug: args.slug,
          description: args.description ?? null,
          provider: args.provider,
          runtime: args.runtime ?? null,
          resources: args.resources,
          network: args.network,
          secretSelection: args.secretSelection,
          literalEnv: args.literalEnv,
          packages: args.packages,
          tools: args.tools,
          setAsDefault: args.setAsDefault,
        },
        templateCtx(scope),
        { surface: "agent" },
      )) as { template: SandboxTemplateSummary };
      revalidate(args);
      return { ok: true, template: out.template };
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err, "Failed to create template"),
      };
    }
  });
}

export async function updateTemplateAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  templateId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  provider?: SandboxProvider;
  runtime?: string | null;
  resources?: SandboxResources;
  network?: SandboxNetwork;
  secretSelection?: SandboxSecretSelection;
  literalEnv?: SandboxLiteralEnv;
  packages?: SandboxTemplatePackages;
  isActive?: boolean;
}): Promise<ActionResult<{ template: SandboxTemplateSummary }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        sandboxTemplateUpdate.name,
        {
          templateId: args.templateId,
          name: args.name,
          slug: args.slug,
          description: args.description,
          provider: args.provider,
          runtime: args.runtime,
          resources: args.resources,
          network: args.network,
          secretSelection: args.secretSelection,
          literalEnv: args.literalEnv,
          packages: args.packages,
          isActive: args.isActive,
        },
        templateCtx(scope),
        { surface: "agent" },
      )) as { template: SandboxTemplateSummary };
      revalidate(args);
      return { ok: true, template: out.template };
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err, "Failed to update template"),
      };
    }
  });
}

export async function setTemplateToolsAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  templateId: string;
  tools: SandboxTemplateTool[];
}): Promise<ActionResult<{ template: SandboxTemplateSummary }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        sandboxTemplateSetTools.name,
        { templateId: args.templateId, tools: args.tools },
        templateCtx(scope),
        { surface: "agent" },
      )) as { template: SandboxTemplateSummary };
      revalidate(args);
      return { ok: true, template: out.template };
    } catch (err) {
      return { ok: false, error: errorMessage(err, "Failed to set tools") };
    }
  });
}

export async function setDefaultTemplateAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  templateId: string;
}): Promise<ActionResult<{ template: SandboxTemplateSummary }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        sandboxTemplateSetDefault.name,
        { templateId: args.templateId },
        templateCtx(scope),
        { surface: "agent" },
      )) as { template: SandboxTemplateSummary };
      revalidate(args);
      return { ok: true, template: out.template };
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err, "Failed to set default template"),
      };
    }
  });
}

export async function deleteTemplateAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  templateId: string;
}): Promise<ActionResult> {
  return asManager(args, async (scope) => {
    try {
      await invoke(
        sandboxTemplateDelete.name,
        { templateId: args.templateId },
        templateCtx(scope),
        { surface: "agent" },
      );
      revalidate(args);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err, "Failed to delete template"),
      };
    }
  });
}

export async function exportTemplateAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  templateId: string;
}): Promise<ActionResult<{ manifest: SandboxTemplateManifest }>> {
  // Export is a read (Member+ allowed) — no manager gate, mirroring the
  // contract's defaultRoles which permit workspace Members.
  const scope = await resolveScope(args.orgSlug, args.workspaceSlug);
  return runInTenantScope(
    { orgId: scope.orgId, workspaceId: scope.workspaceId },
    async () => {
      try {
        const out = (await invoke(
          sandboxTemplateExport.name,
          { templateId: args.templateId },
          templateCtx(scope),
          { surface: "agent" },
        )) as { manifest: SandboxTemplateManifest };
        return { ok: true, manifest: out.manifest };
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err, "Failed to export template"),
        };
      }
    },
  );
}

export async function importTemplateAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  environmentId: string;
  manifest: SandboxTemplateManifest;
  slug?: string;
  setAsDefault?: boolean;
}): Promise<
  ActionResult<{ template: SandboxTemplateSummary; warnings: string[] }>
> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        sandboxTemplateImport.name,
        {
          environmentId: args.environmentId,
          manifest: args.manifest,
          slug: args.slug,
          setAsDefault: args.setAsDefault,
        },
        templateCtx(scope),
        { surface: "agent" },
      )) as { template: SandboxTemplateSummary; warnings: string[] };
      revalidate(args);
      return { ok: true, template: out.template, warnings: out.warnings };
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err, "Failed to import template"),
      };
    }
  });
}
