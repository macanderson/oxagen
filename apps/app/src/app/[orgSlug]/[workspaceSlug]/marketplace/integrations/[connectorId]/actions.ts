"use server";

/**
 * actions.ts — server action for the connector setup wizard
 * (Marketplace → Integrations → [connectorId]).
 *
 * getConnectorSetupSchemaAction SSR-prefetches the connector's config schema
 * via `get_plugin_schema` so the wizard renders pre-filled instead of a
 * client-side fetch waterfall / flash of loading skeleton, and an unknown
 * connectorId surfaces as a proper 404 from the page rather than an inline
 * "couldn't load" client error. Same pattern as
 * knowledge/memory/actions.ts: session guard → resolveOrg/resolveWorkspace
 * (IDOR-safe slug resolution) → assertOrgMember → assertWorkspaceMember
 * (apps/app does not bootstrap IAM, so invoke() skips role checks — this
 * re-derives the caller's workspace role from Postgres before invoking) →
 * invoke() with opts.surface: "agent" (get_plugin_schema declares
 * surfaces: ["api","mcp","agent"], not "app" — passing "app" there would
 * throw surface_denied).
 *
 * The actual install/configure submission is NOT routed through a server
 * action here — ConnectorConfigForm (apps/app/src/components/connectors/
 * connector-config-form.tsx) already does it client-side via fetch() against
 * the real, session-authenticated Hono routes POST /integrations and
 * PATCH /integrations/:id/configure (apps/api/src/routes/v1/integration.ts),
 * which call invoke(install_integration/configure_integration) themselves.
 * Those routes sit behind authMiddleware/orgMiddleware/workspaceMiddleware,
 * so the client fetch is not a bypass of the capability kernel — it is the
 * same proven pattern edit-source-config-sheet.tsx already uses for
 * connection.update.
 */

import { invoke } from "@oxagen/oxagen";
// Side-effect import: binds every handler so invoke() can resolve
// "get_plugin_schema" (same pattern as knowledge/memory/actions.ts).
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

export type ConnectorSetupSchemaResult =
  | { ok: true; schema: ConnectorPluginSchema }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Shared IAM helper — apps/app never bootstraps IAM, so invoke() skips role
// checks in the app surface. Re-read the caller's workspace role from
// Postgres before returning schema/config data (same gate
// knowledge/memory/actions.ts uses, lowered to "member" since reading a
// connector schema to drive the setup form only requires workspace
// membership, not admin/owner).
// ---------------------------------------------------------------------------

async function assertWorkspaceMember(
  workspaceId: string,
  userId: string,
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
  const role = rows[0]?.role ?? "";
  return ["owner", "member"].includes(role.toLowerCase()) ? "ok" : "denied";
}

export async function getConnectorSetupSchemaAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  connectorId: string;
}): Promise<ConnectorSetupSchemaResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, connectorId } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // IDOR guard: caller must be an org member.
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to set up a connector.",
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
      const out = (await invoke(
        "get_plugin_schema",
        { pluginId: connectorId },
        ctx,
        { surface: "agent" },
      )) as ConnectorPluginSchema;
      return { ok: true, schema: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectorId },
        "marketplace.integrations.[connectorId]: getConnectorSetupSchemaAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return {
        ok: false,
        error: message || "Failed to load connector schema.",
      };
    }
  });
}
