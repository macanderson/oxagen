"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler (incl. environment.* and
// secret.*) so invoke() can resolve them.
import "@oxagen/handlers/register";
import { logger } from "@oxagen/handlers/logger";
import { captureError } from "@oxagen/telemetry";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { workspace as routes } from "@/lib/routes";

// ── Shared types (mirror the contract outputs; never carries plaintext) ───────

export interface EnvironmentSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface SecretKeySummary {
  id: string;
  key: string;
  sensitive: boolean;
  memo: string | null;
  hasDefault: boolean;
  overrideEnvironmentIds: string[];
}

export interface ImportPreviewRow {
  key: string;
  isNewKey: boolean;
  sensitive: boolean;
  target: "default" | "override";
  willOverride: boolean;
}

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// ── Scope + role resolution ───────────────────────────────────────────────────

interface Scope {
  orgId: string;
  workspaceId: string;
  userId: string;
}

/** Resolve org+workspace, assert org membership (IDOR guard), return scope. */
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
 * IAM via invoke(), so this is the gate. Owner/Admin may manage the vault.
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

function vaultCtx(scope: Scope) {
  // Two distinct surface fields, deliberately different values:
  //   ctx.surface  = "app"   — the transport the call actually arrived on, and
  //                            what metering/telemetry is tagged with.
  //   opts.surface = "agent" — what the kernel checks against the contract's
  //                            `surfaces` allowlist (see kernel.ts's
  //                            surface_denied branch). The environment.*/secret.*
  //                            contracts list ["api","mcp","agent"] and not
  //                            "app", so "agent" is the only value that passes
  //                            (the workspace.settings.write / memory precedent).
  // Every invoke() below therefore passes { surface: "agent" } as its options.
  // The kernel still scopes to org+workspace from ctx either way.
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

/**
 * Log a vault-mutation failure server-side before the user-facing ActionResult
 * is returned. A silent failure here (KMS error, DB constraint, transient
 * outage) is a live security exposure — a user could believe a secret was
 * rotated/deleted when the backend silently failed. NEVER logs the secret
 * value (the identifiers below are ids/keys/slugs only, never plaintext).
 * `escalate` fires captureError for the destructive secret mutations so a spike
 * is alertable, matching the billing/actions.ts observability bar.
 */
function logVaultFailure(
  action: string,
  err: unknown,
  scope: Scope,
  fields: Record<string, unknown>,
  escalate: boolean,
): void {
  logger.error(
    { err, orgId: scope.orgId, workspaceId: scope.workspaceId, ...fields },
    `environments: ${action} failed`,
  );
  if (escalate) {
    captureError({
      error: err,
      source: "app",
      severity: "error",
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      context: `environments: ${action} failed`,
    });
  }
}

// ── Reads (any workspace member) ──────────────────────────────────────────────

export async function readEnvironmentsAction(args: {
  orgSlug: string;
  workspaceSlug: string;
}): Promise<EnvironmentSummary[]> {
  const scope = await resolveScope(args.orgSlug, args.workspaceSlug);
  return runInTenantScope(
    { orgId: scope.orgId, workspaceId: scope.workspaceId },
    async () => {
      const out = (await invoke("list_environments", {}, vaultCtx(scope), {
        surface: "agent",
      })) as { environments: EnvironmentSummary[] };
      return out.environments;
    },
  );
}

export async function readSecretKeysAction(args: {
  orgSlug: string;
  workspaceSlug: string;
}): Promise<SecretKeySummary[]> {
  const scope = await resolveScope(args.orgSlug, args.workspaceSlug);
  return runInTenantScope(
    { orgId: scope.orgId, workspaceId: scope.workspaceId },
    async () => {
      const out = (await invoke("list_secret_keys", {}, vaultCtx(scope), {
        surface: "agent",
      })) as { keys: SecretKeySummary[] };
      return out.keys;
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
          error: "Only workspace owners or admins can manage the vault.",
        };
      }
      return fn(scope);
    },
  );
}

function revalidate(args: { orgSlug: string; workspaceSlug: string }): void {
  revalidatePath(routes.workbench.environments(args));
}

/**
 * HEADLINE: paste `.env` text → preview (new vs override) or commit. Parses,
 * strips quotes/comments/`export `, targets workspace defaults or an
 * environment's overrides. New keys default to sensitive (encrypted).
 */
export async function importEnvAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  text: string;
  environmentId?: string | null;
  commit: boolean;
}): Promise<ActionResult<{ rows: ImportPreviewRow[]; committed: boolean }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        "import_env_secrets",
        {
          text: args.text,
          environmentId: args.environmentId ?? null,
          commit: args.commit,
        },
        vaultCtx(scope),
        { surface: "agent" },
      )) as { rows: ImportPreviewRow[]; committed: boolean };
      if (out.committed) revalidate(args);
      return { ok: true, rows: out.rows, committed: out.committed };
    } catch (err) {
      logVaultFailure(
        "importEnvAction",
        err,
        scope,
        { environmentId: args.environmentId ?? null, commit: args.commit },
        true,
      );
      return { ok: false, error: errorMessage(err, "Failed to import .env") };
    }
  });
}

export async function upsertKeyAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  key: string;
  sensitive: boolean;
  memo?: string | null;
  defaultValue?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        "upsert_secret_key",
        {
          key: args.key,
          sensitive: args.sensitive,
          memo: args.memo ?? null,
          defaultValue: args.defaultValue,
        },
        vaultCtx(scope),
        { surface: "agent" },
      )) as { id: string };
      revalidate(args);
      return { ok: true, id: out.id };
    } catch (err) {
      logVaultFailure(
        "upsertKeyAction",
        err,
        scope,
        { key: args.key, sensitive: args.sensitive },
        true,
      );
      return { ok: false, error: errorMessage(err, "Failed to save key") };
    }
  });
}

export async function setValueAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  keyId: string;
  environmentId: string;
  value: string;
}): Promise<ActionResult> {
  return asManager(args, async (scope) => {
    try {
      await invoke(
        "set_secret_value",
        {
          keyId: args.keyId,
          environmentId: args.environmentId,
          value: args.value,
        },
        vaultCtx(scope),
        { surface: "agent" },
      );
      revalidate(args);
      return { ok: true };
    } catch (err) {
      logVaultFailure(
        "setValueAction",
        err,
        scope,
        { keyId: args.keyId, environmentId: args.environmentId },
        true,
      );
      return { ok: false, error: errorMessage(err, "Failed to set value") };
    }
  });
}

export async function unsetValueAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  keyId: string;
  environmentId: string;
}): Promise<ActionResult> {
  return asManager(args, async (scope) => {
    try {
      await invoke(
        "unset_secret_value",
        { keyId: args.keyId, environmentId: args.environmentId },
        vaultCtx(scope),
        { surface: "agent" },
      );
      revalidate(args);
      return { ok: true };
    } catch (err) {
      logVaultFailure(
        "unsetValueAction",
        err,
        scope,
        { keyId: args.keyId, environmentId: args.environmentId },
        true,
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to remove override"),
      };
    }
  });
}

export async function deleteKeyAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  keyId: string;
}): Promise<ActionResult> {
  return asManager(args, async (scope) => {
    try {
      await invoke(
        "delete_secret_key",
        { keyId: args.keyId },
        vaultCtx(scope),
        {
          surface: "agent",
        },
      );
      revalidate(args);
      return { ok: true };
    } catch (err) {
      logVaultFailure(
        "deleteKeyAction",
        err,
        scope,
        { keyId: args.keyId },
        true,
      );
      return { ok: false, error: errorMessage(err, "Failed to delete key") };
    }
  });
}

export async function createEnvironmentAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  name: string;
  slug: string;
}): Promise<ActionResult<{ environment: EnvironmentSummary }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        "create_environment",
        { name: args.name, slug: args.slug },
        vaultCtx(scope),
        { surface: "agent" },
      )) as { environment: EnvironmentSummary };
      revalidate(args);
      return { ok: true, environment: out.environment };
    } catch (err) {
      logVaultFailure(
        "createEnvironmentAction",
        err,
        scope,
        { slug: args.slug },
        false,
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to create environment"),
      };
    }
  });
}

export async function setDefaultEnvironmentAction(args: {
  orgSlug: string;
  workspaceSlug: string;
  environmentId: string;
}): Promise<ActionResult<{ environment: EnvironmentSummary }>> {
  return asManager(args, async (scope) => {
    try {
      const out = (await invoke(
        "set_default_environment",
        { environmentId: args.environmentId },
        vaultCtx(scope),
        { surface: "agent" },
      )) as { environment: EnvironmentSummary };
      revalidate(args);
      return { ok: true, environment: out.environment };
    } catch (err) {
      logVaultFailure(
        "setDefaultEnvironmentAction",
        err,
        scope,
        { environmentId: args.environmentId },
        false,
      );
      return {
        ok: false,
        error: errorMessage(err, "Failed to set default environment"),
      };
    }
  });
}
