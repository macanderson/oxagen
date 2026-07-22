"use server";

/**
 * actions.ts — server actions for Automations → Lineage, the fleet-lineage
 * explorer (issue #1078). Follows the exact pattern used by
 * knowledge/graph/actions.ts:
 *   1. getSessionOrRedirect() → session guard
 *   2. resolveOrg / resolveWorkspace → IDOR + org/workspace resolution
 *   3. assertOrgMember() → org membership guard
 *   4. assertWorkspaceMember() (inline) → workspace role guard, since
 *      apps/app does NOT bootstrap IAM and invoke() skips role checks. Each
 *      action gates against the SAME workspace roles its own capability's
 *      `defaultRoles.workspace` declares in packages/oxagen/src/contracts —
 *      query_lineage allows Owner/Member/Viewer, list_subagent_fanouts
 *      allows only Owner/Member — so the two actions below intentionally use
 *      different allow-lists.
 *   5. invoke() with the capability's exact `name:` (verified against
 *      packages/oxagen/src/contracts/lineage.query.ts and
 *      agent.subagent_fanout.list.ts) called with `{ surface: "agent" }`
 *   6. return an `{ ok: true, ... } | { ok: false, error }` result — no thrown
 *      errors cross the server-action boundary
 */

import { and, eq } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: binds every handler so invoke() can resolve.
import "@oxagen/handlers/register";
import { withTenantDb, schema } from "@oxagen/database";
import type { LineageQueryOutput } from "@oxagen/oxagen/contracts/lineage.query";
import type { AgentSubagentFanoutListOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Result types (exported for client prop typing)
// ---------------------------------------------------------------------------

export type QueryLineageResult =
  | { ok: true; data: LineageQueryOutput }
  | { ok: false; error: string };

export type ListRecentFanoutsResult =
  | { ok: true; fanouts: AgentSubagentFanoutListOutput["fanouts"] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Shared IAM helper — apps/app never bootstraps IAM, so re-read the caller's
// workspace role from Postgres before every read. `allowedRoles` mirrors the
// SPECIFIC capability's own `defaultRoles.workspace` (see the header note) —
// not a single hard-coded list shared by every action on this page.
// ---------------------------------------------------------------------------

async function assertWorkspaceMember(
  workspaceId: string,
  userId: string,
  allowedRoles: readonly string[],
): Promise<"ok" | "denied"> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({ role: schema.workspaceUsers.role })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, workspaceId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  const role = (rows[0]?.role ?? "").toLowerCase();
  return allowedRoles.includes(role) ? "ok" : "denied";
}

function makeCtx(orgId: string, workspaceId: string, userId: string) {
  return {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

interface Gated {
  session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  org: Awaited<ReturnType<typeof resolveOrg>>;
  ws: Awaited<ReturnType<typeof resolveWorkspace>>;
}

/** Session + org resolution + org-membership IDOR guard (steps 1–3). */
async function resolveAndGate(
  orgSlug: string,
  workspaceSlug: string,
): Promise<Gated> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);
  return { session, org, ws };
}

// ---------------------------------------------------------------------------
// queryLineageAction — lineage.query ("query_lineage"). The dispatch tree
// for one fan-out. Workspace roles: Owner, Member, Viewer (read-only, low
// sensitivity — matches the contract's defaultRoles.workspace exactly).
// ---------------------------------------------------------------------------

const QUERY_LINEAGE_ROLES = ["owner", "member", "viewer"] as const;

export async function queryLineageAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  dispatchId: string;
  maxDepth?: number;
  maxNodes?: number;
}): Promise<QueryLineageResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(
      ws.id,
      session.user.id,
      QUERY_LINEAGE_ROLES,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to view fleet lineage.",
      };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("query_lineage", params, ctx, {
        surface: "agent",
      })) as LineageQueryOutput;
      return { ok: true, data: out };
    } catch (err) {
      logger.error(
        {
          err,
          orgId: org.id,
          workspaceId: ws.id,
          dispatchId: input.dispatchId,
        },
        "automations.lineage: queryLineageAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return {
        ok: false,
        error: message || "Failed to load the dispatch tree.",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// listRecentFanoutsAction — agent.subagent_fanout.list
// ("list_subagent_fanouts"). Powers the dispatch picker when no dispatchId is
// selected yet. Workspace roles: Owner, Member only (matches the contract's
// own defaultRoles.workspace — narrower than query_lineage's).
// ---------------------------------------------------------------------------

const LIST_FANOUTS_ROLES = ["owner", "member"] as const;

export async function listRecentFanoutsAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  limit?: number;
}): Promise<ListRecentFanoutsResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(
      ws.id,
      session.user.id,
      LIST_FANOUTS_ROLES,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to list recent dispatches.",
      };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("list_subagent_fanouts", params, ctx, {
        surface: "agent",
      })) as AgentSubagentFanoutListOutput;
      return { ok: true, fanouts: out.fanouts };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id },
        "automations.lineage: listRecentFanoutsAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return {
        ok: false,
        error: message || "Failed to list recent dispatches.",
      };
    }
  });
}
