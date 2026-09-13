"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler so invoke() can resolve.
import "@oxagen/handlers/register";
// agent.* capabilities (e.g. agent.memory.policy.write) bind via the agent register.
import "@oxagen/agent/register";
import type { AgentMemoryPolicyWriteOutput } from "@oxagen/oxagen/contracts/agent.memory_policy.write";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const MemoryPolicySchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  halfLifeLowDays: z.number().int().min(1).max(3650),
  halfLifeHighDays: z.number().int().min(1).max(3650),
  recallThreshold: z.number().min(0).max(1),
  complianceThreshold: z.number().int().min(1).max(100),
  defaultDecayFloor: z.number().min(0).max(100),
});

type MemoryPolicyInput = z.infer<typeof MemoryPolicySchema>;

export type SaveMemoryPolicyResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Write action
//
// Routes the memory policy save through the `agent.memory.policy.write`
// kernel capability — same chokepoint reached from the in-app agent, MCP,
// and CLI — so the edit is metered, audited, and IAM-gated with zero surface
// drift.
//
// Scoped to the authenticated user's org + workspace; resolveWorkspace calls
// notFound() if the workspace does not belong to the org, preventing
// cross-tenant writes. apps/app does NOT bootstrap IAM (invoke() in-app skips
// role checks), so we re-read the caller's workspace role server-side and
// reject non-owners before invoking — matching the general settings action.
// ---------------------------------------------------------------------------

export async function saveMemoryPolicyAction(
  input: MemoryPolicyInput,
): Promise<SaveMemoryPolicyResult> {
  const session = await getSessionOrRedirect();

  const parsed = MemoryPolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const {
    orgSlug,
    workspaceSlug,
    halfLifeLowDays,
    halfLifeHighDays,
    recallThreshold,
    complianceThreshold,
    defaultDecayFloor,
  } = parsed.data;

  // Resolve org + workspace — notFound() on mismatch prevents cross-tenant writes.
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // Assert the caller is an org member first (IDOR guard).
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      // Re-read the caller's workspace role server-side — never trust the client.
      // apps/app does not enforce IAM via invoke(), so this is the gate.
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

      // Owner-only — stricter than the owner/admin gate the other Agent Defaults
      // sub-tabs use, because memory policy governs what the agent retains.
      const wsRole = wsRoleRows[0]?.role ?? "";
      if (wsRole.toLowerCase() !== "owner") {
        return {
          ok: false,
          error: "Only workspace owners can edit memory policy.",
        };
      }

      const ctx = {
        orgId: org.id,
        workspaceId: ws.id,
        userId: session.user.id,
        apiKeyId: null as string | null,
        requestId: crypto.randomUUID(),
        surface: "app" as const,
        messageId: null as string | null,
      };

      try {
        // CRITICAL: pass { surface: "agent" } — the contract's `surfaces` list is
        // ["api","mcp","agent"] and does NOT include "app"; passing "app" throws
        // surface_denied. (Same as the workspace.settings.write precedent.)
        (await invoke(
          "update_memory_policy",
          {
            halfLifeLowDays,
            halfLifeHighDays,
            recallThreshold,
            complianceThreshold,
            defaultDecayFloor,
          },
          ctx,
          { surface: "agent" },
        )) as AgentMemoryPolicyWriteOutput;

        const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
        revalidatePath(workspace.settings.agentDefaults(routeCtx));
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        return { ok: false, error: message || "Failed to save memory policy." };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Read action
//
// Fetches the current memory policy for the page. Called from the RSC page
// component server-side; no session required here since the page layout
// already guards authentication via the workspace resolver.
// ---------------------------------------------------------------------------

export async function readMemoryPolicyAction(args: {
  orgSlug: string;
  workspaceSlug: string;
}): Promise<{
  halfLifeLowDays: number;
  halfLifeHighDays: number;
  recallThreshold: number;
  complianceThreshold: number;
  defaultDecayFloor: number;
}> {
  // invoke() from apps/app skips kernel IAM and the org/workspace come from
  // client-supplied slugs — authenticate and assert org membership (mirrors
  // saveMemoryPolicyAction) so a session scoped to org A can't read org B's
  // memory policy by passing its slugs. notFound() on non-member.
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(args.orgSlug);
  const ws = await resolveWorkspace(org.id, args.workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      const ctx = {
        orgId: org.id,
        workspaceId: ws.id,
        userId: session.user.id,
        apiKeyId: null as string | null,
        requestId: crypto.randomUUID(),
        surface: "app" as const,
        messageId: null as string | null,
      };
      const result = await invoke("get_memory_policy", {}, ctx, {
        surface: "agent",
      });
      return result as {
        halfLifeLowDays: number;
        halfLifeHighDays: number;
        recallThreshold: number;
        complianceThreshold: number;
        defaultDecayFloor: number;
      };
    },
  );
}
