"use server";

/**
 * actions.ts — server actions for the "Connect a source" wizard
 * (Knowledge → Sources → Connect, docs/web-app-2.0/workspace/knowledge/sources/connect/spec.md).
 *
 * Every action follows the same shape: session guard → resolveOrg/resolveWorkspace
 * (IDOR-safe slug resolution, same as marketplace/integrations/[connectorId]/actions.ts
 * and knowledge/ontology/page.tsx) → assertOrgMember → assertCapabilityAccess (apps/app
 * does NOT bootstrap kernel IAM, so invoke() skips the role checks encoded in each
 * capability's `defaultRoles` — this re-derives the caller's org/workspace role from
 * Postgres and enforces the SAME allow-list each contract declares) → invoke() with
 * opts.surface: "agent" (none of these capabilities declare "app" in `surfaces`, so
 * passing ctx.surface: "app" straight through would throw surface_denied).
 *
 * Capabilities used (verified against packages/oxagen/src/contracts/ before wiring):
 *   get_plugin_schema, validate_plugin_schema, create_connection, preview_connection,
 *   suggest_connection_mappings, get_connection_mappings, set_connection_mappings,
 *   configure_integration.
 *
 * `install_integration` is NOT called here. Its handler
 * (packages/handlers/src/integration.install.ts) inserts a NEW
 * `ingestion.source_connections` row via a path parallel to (not shared with)
 * connection.create — and unlike connection.create it has no `authCredential` input at
 * all, so it cannot carry the credentials this wizard's Credentials step collects.
 * Calling both would create two connection rows for one wizard run. There is also no
 * `integration.list`/`connection.list`-equivalent in this wizard's allowed capability
 * set to check whether a connector is "already installed" (the condition the spec's
 * Step 1 describes), so the safe choice is to use `create_connection` as the single
 * creation call and leave `install_integration` unwired. Documented in the task report.
 */

import { invoke } from "@oxagen/oxagen";
// Side-effect import: binds every handler so invoke() can resolve capability names
// (same pattern as marketplace/integrations/[connectorId]/actions.ts).
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
  getOrgRole,
} from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import type { ConnectionCreateOutput } from "@oxagen/oxagen/contracts/connection.create";
import type { ConnectionPreviewOutput } from "@oxagen/oxagen/contracts/connection.preview";
import type { ConnectionMappingsSuggestOutput } from "@oxagen/oxagen/contracts/connection.mappings.suggest";
import type { ConnectionMappingsGetOutput } from "@oxagen/oxagen/contracts/connection.mappings.get";
import type { ConnectionMappingsSetOutput } from "@oxagen/oxagen/contracts/connection.mappings.set";
import type { IntegrationConfigureOutput } from "@oxagen/oxagen/contracts/integration.configure";

export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

interface OrgWorkspaceSlugs {
  orgSlug: string;
  workspaceSlug: string;
}

// ---------------------------------------------------------------------------
// Access gate — apps/app never bootstraps kernel IAM, so invoke() skips role
// checks in this surface (see CLAUDE.md "apps/app does not bootstrap IAM").
// Re-derive the caller's org role (getOrgRole, cached, withSystemDb) and, when
// that's insufficient, their workspace role (withTenantDb) and compare against
// the allow-lists each capability's `defaultRoles` declares.
// ---------------------------------------------------------------------------

async function getWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<string> {
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
  return (rows[0]?.role ?? "").toLowerCase();
}

async function assertCapabilityAccess(
  orgId: string,
  workspaceId: string,
  userId: string,
  allowed: { org: readonly string[]; workspace: readonly string[] },
): Promise<"ok" | "denied"> {
  const orgRole = (await getOrgRole(orgId, userId))?.toLowerCase() ?? "";
  if (allowed.org.includes(orgRole)) return "ok";
  const workspaceRole = await getWorkspaceRole(workspaceId, userId);
  return allowed.workspace.includes(workspaceRole) ? "ok" : "denied";
}

// Mirrors each contract's `defaultRoles` (packages/oxagen/src/contracts/*.ts).
const ROLES_SCHEMA_READ = {
  org: ["owner", "admin"],
  workspace: ["owner", "member"],
} as const;
const ROLES_CONNECTION_WRITE = {
  org: ["owner", "admin"],
  workspace: ["owner"],
} as const;
const ROLES_MAPPINGS_READ = {
  org: ["owner", "admin"],
  workspace: ["owner", "member"],
} as const;
const ROLES_INTEGRATION_CONFIGURE = {
  org: ["owner", "admin"],
  workspace: ["owner", "member"],
} as const;

async function resolveScope(orgSlug: string, workspaceSlug: string) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  // IDOR guard: caller must be an org member before anything else runs.
  await assertOrgMember(org.id, session.user.id);
  return { session, org, ws };
}

function buildCtx(orgId: string, workspaceId: string, userId: string) {
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

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// get_plugin_schema — Step 2 (Credentials): dynamic form schema.
// ---------------------------------------------------------------------------

export async function getConnectSourceSchemaAction(
  input: OrgWorkspaceSlugs & { connectorId: string },
): Promise<ActionResult<ConnectorPluginSchema>> {
  const { orgSlug, workspaceSlug, connectorId } = input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_SCHEMA_READ,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error:
          "You do not have permission to connect a source in this workspace.",
      };
    }
    try {
      const out = (await invoke(
        "get_plugin_schema",
        { pluginId: connectorId },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as ConnectorPluginSchema;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectorId },
        "knowledge.sources.connect: getConnectSourceSchemaAction failed",
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to load connector schema."),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// validate_plugin_schema — Step 2 (Credentials): inline field validation.
// ---------------------------------------------------------------------------

export interface ValidateConnectSourceConfigInput extends OrgWorkspaceSlugs {
  connectorId: string;
  authSchemeId?: string;
  config: Record<string, unknown>;
}

export interface ValidateConnectSourceConfigOutput {
  valid: boolean;
  errors: Array<{ field: string; message: string; code: string }>;
}

export async function validateConnectSourceConfigAction(
  input: ValidateConnectSourceConfigInput,
): Promise<ActionResult<ValidateConnectSourceConfigOutput>> {
  const { orgSlug, workspaceSlug, connectorId, authSchemeId, config } = input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_SCHEMA_READ,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error:
          "You do not have permission to connect a source in this workspace.",
      };
    }
    try {
      const out = (await invoke(
        "validate_plugin_schema",
        { pluginId: connectorId, authSchemeId, config },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as ValidateConnectSourceConfigOutput;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectorId },
        "knowledge.sources.connect: validateConnectSourceConfigAction failed",
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to validate configuration."),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// create_connection — Step 2 → 3 transition: provisions the connection record.
// ---------------------------------------------------------------------------

export interface CreateSourceConnectionInput extends OrgWorkspaceSlugs {
  connectorId: string;
  displayName: string;
  connectionConfig?: Record<string, unknown>;
  authCredential: Record<string, unknown>;
}

export async function createSourceConnectionAction(
  input: CreateSourceConnectionInput,
): Promise<ActionResult<ConnectionCreateOutput>> {
  const {
    orgSlug,
    workspaceSlug,
    connectorId,
    displayName,
    connectionConfig,
    authCredential,
  } = input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_CONNECTION_WRITE,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error:
          "You must be a workspace owner (or org owner/admin) to connect a source.",
      };
    }
    try {
      const out = (await invoke(
        "create_connection",
        { connectorId, displayName, connectionConfig, authCredential },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as ConnectionCreateOutput;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectorId },
        "knowledge.sources.connect: createSourceConnectionAction failed",
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to create the connection."),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// preview_connection — Step 3 (Preview): sample records before commitment.
// ---------------------------------------------------------------------------

export async function previewSourceConnectionAction(
  input: OrgWorkspaceSlugs & { connectionId: string },
): Promise<ActionResult<ConnectionPreviewOutput>> {
  const { orgSlug, workspaceSlug, connectionId } = input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_CONNECTION_WRITE,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error: "You do not have permission to preview this connection.",
      };
    }
    try {
      const out = (await invoke(
        "preview_connection",
        { connectionId },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as ConnectionPreviewOutput;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectionId },
        "knowledge.sources.connect: previewSourceConnectionAction failed",
      );
      // Preserve the raw connector error message per spec ("Error states" — preview
      // failure shows a retry with the raw connector error, not a generic failure).
      return {
        ok: false,
        error: errorMessage(err, "Failed to preview this connection."),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// suggest_connection_mappings — Step 4 (Mappings): LLM-suggested mappings.
// ---------------------------------------------------------------------------

export interface SuggestSourceMappingsInput extends OrgWorkspaceSlugs {
  connectionId: string;
  recordTypes: Array<{
    sourceRecordType: string;
    displayName: string;
    description?: string;
    sampleFields: string[];
    sampleRecords?: Record<string, unknown>[];
  }>;
  existingEntityTypes?: string[];
}

export async function suggestSourceMappingsAction(
  input: SuggestSourceMappingsInput,
): Promise<ActionResult<ConnectionMappingsSuggestOutput>> {
  const {
    orgSlug,
    workspaceSlug,
    connectionId,
    recordTypes,
    existingEntityTypes,
  } = input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_CONNECTION_WRITE,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error:
          "You do not have permission to generate mappings for this connection.",
      };
    }
    try {
      const out = (await invoke(
        "suggest_connection_mappings",
        { connectionId, recordTypes, existingEntityTypes },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as ConnectionMappingsSuggestOutput;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectionId },
        "knowledge.sources.connect: suggestSourceMappingsAction failed",
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to generate mapping suggestions."),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// get_connection_mappings — resume: reload mappings already saved for this
// connection (e.g. the user left after Step 4 and returned via ?connectionId=).
// ---------------------------------------------------------------------------

export async function getSourceMappingsAction(
  input: OrgWorkspaceSlugs & { connectionId: string },
): Promise<ActionResult<ConnectionMappingsGetOutput>> {
  const { orgSlug, workspaceSlug, connectionId } = input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_MAPPINGS_READ,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error: "You do not have permission to view this connection's mappings.",
      };
    }
    try {
      const out = (await invoke(
        "get_connection_mappings",
        { connectionId },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as ConnectionMappingsGetOutput;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectionId },
        "knowledge.sources.connect: getSourceMappingsAction failed",
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to load saved mappings."),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// set_connection_mappings — Step 5 (Confirm): persist + activate.
// ---------------------------------------------------------------------------

export interface ConfirmSourceMappingsInput extends OrgWorkspaceSlugs {
  connectionId: string;
  mappings: Array<{
    sourceRecordType: string;
    oxagenEntityType: string;
    propertyMappings: Record<string, string>;
  }>;
  activateConnection?: boolean;
}

export async function confirmSourceMappingsAction(
  input: ConfirmSourceMappingsInput,
): Promise<ActionResult<ConnectionMappingsSetOutput>> {
  const { orgSlug, workspaceSlug, connectionId, mappings, activateConnection } =
    input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_CONNECTION_WRITE,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error:
          "You must be a workspace owner (or org owner/admin) to activate this connection.",
      };
    }
    try {
      const out = (await invoke(
        "set_connection_mappings",
        {
          connectionId,
          mappings,
          activateConnection: activateConnection ?? true,
        },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as ConnectionMappingsSetOutput;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, connectionId },
        "knowledge.sources.connect: confirmSourceMappingsAction failed",
      );
      return {
        ok: false,
        error: errorMessage(
          err,
          "Failed to save and activate this connection.",
        ),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// configure_integration — optional sync settings applied alongside the
// connection. integrationId is the same
// `source_connections.publicId` returned by create_connection (see
// packages/handlers/src/integration.configure.ts, which resolves by public
// ID against the same table connection.create writes to).
// ---------------------------------------------------------------------------

export interface ConfigureSourceIntegrationInput extends OrgWorkspaceSlugs {
  integrationId: string;
  syncCadence?: "manual" | "polling" | "webhook";
}

export async function configureSourceIntegrationAction(
  input: ConfigureSourceIntegrationInput,
): Promise<ActionResult<IntegrationConfigureOutput>> {
  const { orgSlug, workspaceSlug, integrationId, syncCadence } = input;
  const { session, org, ws } = await resolveScope(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertCapabilityAccess(
      org.id,
      ws.id,
      session.user.id,
      ROLES_INTEGRATION_CONFIGURE,
    );
    if (gate === "denied") {
      return {
        ok: false,
        error: "You do not have permission to configure this integration.",
      };
    }
    try {
      const out = (await invoke(
        "configure_integration",
        { integrationId, syncCadence },
        buildCtx(org.id, ws.id, session.user.id),
        { surface: "agent" },
      )) as IntegrationConfigureOutput;
      return { ok: true, value: out };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, integrationId },
        "knowledge.sources.connect: configureSourceIntegrationAction failed",
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to save advanced settings."),
      };
    }
  });
}
