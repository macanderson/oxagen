/**
 * Sandbox templates + agent-environment bindings
 * (see docs/specs/sandbox-templates-portable/plan.md).
 *
 * Portable sandbox configuration: CRUD, the only-one-default-per-environment
 * invariant (atomic swap, promote-before-remove), replace-set tools, manifest
 * export/import (secret NAMES only), agent bindings with the only-one-primary
 * invariant, and the run-time resolution chain. All DB access is RLS-enforced
 * via withTenantDb; the partial-unique indexes are the backstop, the handler
 * guards are the user-facing contract.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type {
  SandboxProvider,
  SandboxResources,
  SandboxNetwork,
  SandboxSecretSelection,
  SandboxLiteralEnv,
  SandboxTemplatePackages,
  SandboxTemplateTool,
  SandboxTemplateManifest,
} from "@oxagen/oxagen/contracts";
import { isValidEnvironmentSlug } from "./environment-service";
import { listSecretKeys, upsertSecretKey } from "../vault/vault-secret-service";

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

export interface SandboxTemplateActor {
  orgId: string;
  workspaceId: string;
  userId?: string | null;
}

export interface SandboxTemplateToolSummary {
  id: string;
  kind: SandboxTemplateTool["kind"];
  ref: string;
  config: Record<string, unknown>;
}

export interface SandboxTemplateSummary {
  id: string;
  environmentId: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  provider: SandboxProvider;
  runtime: string | null;
  resources: SandboxResources;
  network: SandboxNetwork;
  secretSelection: SandboxSecretSelection;
  literalEnv: SandboxLiteralEnv;
  packages: SandboxTemplatePackages;
  tools: SandboxTemplateToolSummary[];
}

export interface AgentEnvironmentBinding {
  id: string;
  agentId: string;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  sandboxTemplateId: string | null;
  sandboxTemplateName: string | null;
  isPrimary: boolean;
}

export interface ResolvedSandboxTemplate {
  environment: { id: string; name: string; slug: string };
  template: SandboxTemplateSummary;
}

// ── column projections ────────────────────────────────────────────────────────
// Built per call, never at module scope: test suites mock @oxagen/database
// with a partial `schema`, and a module-level `schema.<table>.<col>` access
// crashes every importer at load time (takes the whole /v1 route mount with it).

const templateColumns = () =>
  ({
    id: schema.sandboxTemplates.id,
    publicId: schema.sandboxTemplates.publicId,
    environmentInternalId: schema.sandboxTemplates.environmentId,
    environmentPublicId: schema.environments.publicId,
    environmentName: schema.environments.name,
    environmentSlug: schema.environments.slug,
    name: schema.sandboxTemplates.name,
    slug: schema.sandboxTemplates.slug,
    description: schema.sandboxTemplates.description,
    isDefault: schema.sandboxTemplates.isDefault,
    isActive: schema.sandboxTemplates.isActive,
    provider: schema.sandboxTemplates.provider,
    runtime: schema.sandboxTemplates.runtime,
    resources: schema.sandboxTemplates.resources,
    network: schema.sandboxTemplates.network,
    secretSelection: schema.sandboxTemplates.secretSelection,
    literalEnv: schema.sandboxTemplates.literalEnv,
    packages: schema.sandboxTemplates.packages,
  }) as const;

interface TemplateRow {
  id: string;
  publicId: string;
  environmentInternalId: string;
  environmentPublicId: string;
  environmentName: string;
  environmentSlug: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  provider: string;
  runtime: string | null;
  resources: unknown;
  network: unknown;
  secretSelection: unknown;
  literalEnv: unknown;
  packages: unknown;
}

function toToolSummary(row: {
  publicId: string;
  kind: string;
  ref: string;
  config: unknown;
}): SandboxTemplateToolSummary {
  return {
    id: row.publicId,
    kind: row.kind as SandboxTemplateTool["kind"],
    ref: row.ref,
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}

function toSummary(
  row: TemplateRow,
  tools: SandboxTemplateToolSummary[],
): SandboxTemplateSummary {
  return {
    id: row.publicId,
    environmentId: row.environmentPublicId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isDefault: row.isDefault,
    isActive: row.isActive,
    provider: row.provider as SandboxProvider,
    runtime: row.runtime,
    resources: (row.resources ?? {}) as SandboxResources,
    network: (row.network ?? { mode: "public" }) as SandboxNetwork,
    secretSelection: (row.secretSelection ?? "all") as SandboxSecretSelection,
    literalEnv: (row.literalEnv ?? {}) as SandboxLiteralEnv,
    packages: (row.packages ?? []) as SandboxTemplatePackages,
    tools,
  };
}

// ── loaders ──────────────────────────────────────────────────────────────────

async function loadTemplateRow(
  tx: Tx,
  workspaceId: string,
  publicId: string,
): Promise<TemplateRow> {
  const [row] = await tx
    .select(templateColumns())
    .from(schema.sandboxTemplates)
    .innerJoin(
      schema.environments,
      eq(schema.environments.id, schema.sandboxTemplates.environmentId),
    )
    .where(
      and(
        eq(schema.sandboxTemplates.workspaceId, workspaceId),
        eq(schema.sandboxTemplates.publicId, publicId),
        isNull(schema.sandboxTemplates.deletedAt),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(`[sandbox-template] template not found: ${publicId}`);
  return row;
}

/** Resolve an environment public id to its internal row (workspace-scoped). */
async function loadEnvironment(
  tx: Tx,
  workspaceId: string,
  publicId: string,
): Promise<{ id: string; name: string; slug: string; isActive: boolean }> {
  const [row] = await tx
    .select({
      id: schema.environments.id,
      name: schema.environments.name,
      slug: schema.environments.slug,
      isActive: schema.environments.isActive,
    })
    .from(schema.environments)
    .where(
      and(
        eq(schema.environments.workspaceId, workspaceId),
        eq(schema.environments.publicId, publicId),
        isNull(schema.environments.deletedAt),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(`[sandbox-template] environment not found: ${publicId}`);
  return row;
}

/** Batch-load tools for a set of template internal ids (no N+1). */
async function loadToolsFor(
  tx: Tx,
  templateInternalIds: string[],
): Promise<Map<string, SandboxTemplateToolSummary[]>> {
  const byTemplate = new Map<string, SandboxTemplateToolSummary[]>();
  if (templateInternalIds.length === 0) return byTemplate;
  const rows = await tx
    .select({
      sandboxTemplateId: schema.sandboxTemplateTools.sandboxTemplateId,
      publicId: schema.sandboxTemplateTools.publicId,
      kind: schema.sandboxTemplateTools.kind,
      ref: schema.sandboxTemplateTools.ref,
      config: schema.sandboxTemplateTools.config,
    })
    .from(schema.sandboxTemplateTools)
    .where(
      inArray(
        schema.sandboxTemplateTools.sandboxTemplateId,
        templateInternalIds,
      ),
    );
  for (const r of rows) {
    const list = byTemplate.get(r.sandboxTemplateId) ?? [];
    list.push(toToolSummary(r));
    byTemplate.set(r.sandboxTemplateId, list);
  }
  return byTemplate;
}

async function loadTemplateWithTools(
  tx: Tx,
  workspaceId: string,
  publicId: string,
): Promise<SandboxTemplateSummary> {
  const row = await loadTemplateRow(tx, workspaceId, publicId);
  const tools = (await loadToolsFor(tx, [row.id])).get(row.id) ?? [];
  return toSummary(row, tools);
}

/** Replace the full tools set for a template within an existing tx. */
async function replaceToolsTx(
  tx: Tx,
  actor: SandboxTemplateActor,
  templateInternalId: string,
  tools: SandboxTemplateTool[],
): Promise<void> {
  await tx
    .delete(schema.sandboxTemplateTools)
    .where(
      eq(schema.sandboxTemplateTools.sandboxTemplateId, templateInternalId),
    );
  if (tools.length === 0) return;
  // De-dupe on (kind, ref) — the unique index forbids duplicates and a manifest
  // may repeat a ref; last write wins.
  const seen = new Map<string, SandboxTemplateTool>();
  for (const t of tools) seen.set(`${t.kind}:${t.ref}`, t);
  await tx.insert(schema.sandboxTemplateTools).values(
    [...seen.values()].map((t) => ({
      orgId: actor.orgId,
      workspaceId: actor.workspaceId,
      sandboxTemplateId: templateInternalId,
      kind: t.kind,
      ref: t.ref,
      config: t.config ?? {},
      createdByUserId: actor.userId ?? null,
      updatedByUserId: actor.userId ?? null,
    })),
  );
}

/** Clear the default flag on every template in an environment (within a tx). */
async function clearEnvDefaultTx(
  tx: Tx,
  actor: SandboxTemplateActor,
  environmentInternalId: string,
): Promise<void> {
  await tx
    .update(schema.sandboxTemplates)
    .set({
      isDefault: false,
      updatedAt: new Date(),
      updatedByUserId: actor.userId ?? null,
    })
    .where(
      and(
        eq(schema.sandboxTemplates.workspaceId, actor.workspaceId),
        eq(schema.sandboxTemplates.environmentId, environmentInternalId),
        eq(schema.sandboxTemplates.isDefault, true),
        isNull(schema.sandboxTemplates.deletedAt),
      ),
    );
}

// ── CRUD ───────────────────────────────────────────────────────────────────────

export async function createTemplate(
  actor: SandboxTemplateActor,
  input: {
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
  },
): Promise<SandboxTemplateSummary> {
  const slug = input.slug.toLowerCase();
  if (!isValidEnvironmentSlug(slug)) {
    throw new Error(`[sandbox-template] invalid slug: ${input.slug}`);
  }
  return withTenantDb(async (tx) => {
    const env = await loadEnvironment(
      tx,
      actor.workspaceId,
      input.environmentId,
    );
    const [row] = await tx
      .insert(schema.sandboxTemplates)
      .values({
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        environmentId: env.id,
        name: input.name,
        slug,
        description: input.description ?? null,
        isDefault: false,
        isActive: true,
        provider: input.provider ?? "modal",
        runtime: input.runtime ?? null,
        resources: input.resources ?? {},
        network: input.network ?? { mode: "public" },
        secretSelection: input.secretSelection ?? "all",
        literalEnv: input.literalEnv ?? {},
        packages: input.packages ?? [],
        createdByUserId: actor.userId ?? null,
        updatedByUserId: actor.userId ?? null,
      })
      .returning({
        id: schema.sandboxTemplates.id,
        publicId: schema.sandboxTemplates.publicId,
      });
    if (!row) throw new Error("[sandbox-template] insert returned no row");
    if (input.tools && input.tools.length > 0) {
      await replaceToolsTx(tx, actor, row.id, input.tools);
    }
    if (input.setAsDefault) {
      await clearEnvDefaultTx(tx, actor, env.id);
      await tx
        .update(schema.sandboxTemplates)
        .set({ isDefault: true, isActive: true, updatedAt: new Date() })
        .where(eq(schema.sandboxTemplates.id, row.id));
    }
    return loadTemplateWithTools(tx, actor.workspaceId, row.publicId);
  });
}

export async function listTemplates(
  actor: SandboxTemplateActor,
  input: { environmentId?: string } = {},
): Promise<SandboxTemplateSummary[]> {
  return withTenantDb(async (tx) => {
    const filters = [
      eq(schema.sandboxTemplates.workspaceId, actor.workspaceId),
      isNull(schema.sandboxTemplates.deletedAt),
    ];
    if (input.environmentId) {
      const env = await loadEnvironment(
        tx,
        actor.workspaceId,
        input.environmentId,
      );
      filters.push(eq(schema.sandboxTemplates.environmentId, env.id));
    }
    const rows = await tx
      .select(templateColumns())
      .from(schema.sandboxTemplates)
      .innerJoin(
        schema.environments,
        eq(schema.environments.id, schema.sandboxTemplates.environmentId),
      )
      .where(and(...filters))
      .orderBy(schema.sandboxTemplates.slug);
    const toolsByTemplate = await loadToolsFor(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toSummary(r, toolsByTemplate.get(r.id) ?? []));
  });
}

export async function getTemplate(
  actor: SandboxTemplateActor,
  input: { templateId: string },
): Promise<SandboxTemplateSummary> {
  return withTenantDb(async (tx) =>
    loadTemplateWithTools(tx, actor.workspaceId, input.templateId),
  );
}

export async function updateTemplate(
  actor: SandboxTemplateActor,
  input: {
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
  },
): Promise<SandboxTemplateSummary> {
  return withTenantDb(async (tx) => {
    const existing = await loadTemplateRow(
      tx,
      actor.workspaceId,
      input.templateId,
    );
    // A default template must stay active — promote another in the same
    // environment before deactivating this one (mirrors the environments guard).
    if (input.isActive === false && existing.isDefault) {
      throw new Error(
        "[sandbox-template] cannot deactivate the default template — promote another template in this environment first",
      );
    }
    const slug =
      input.slug !== undefined ? input.slug.toLowerCase() : undefined;
    if (slug !== undefined && !isValidEnvironmentSlug(slug)) {
      throw new Error(`[sandbox-template] invalid slug: ${input.slug}`);
    }
    await tx
      .update(schema.sandboxTemplates)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        ...(input.resources !== undefined
          ? { resources: input.resources }
          : {}),
        ...(input.network !== undefined ? { network: input.network } : {}),
        ...(input.secretSelection !== undefined
          ? { secretSelection: input.secretSelection }
          : {}),
        ...(input.literalEnv !== undefined
          ? { literalEnv: input.literalEnv }
          : {}),
        ...(input.packages !== undefined ? { packages: input.packages } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
        updatedByUserId: actor.userId ?? null,
      })
      .where(eq(schema.sandboxTemplates.id, existing.id));
    return loadTemplateWithTools(tx, actor.workspaceId, existing.publicId);
  });
}

export async function deleteTemplate(
  actor: SandboxTemplateActor,
  input: { templateId: string },
): Promise<{ ok: true }> {
  await withTenantDb(async (tx) => {
    const existing = await loadTemplateRow(
      tx,
      actor.workspaceId,
      input.templateId,
    );
    if (existing.isDefault) {
      throw new Error(
        "[sandbox-template] cannot delete the default template — promote another template in this environment first",
      );
    }
    await tx
      .update(schema.sandboxTemplates)
      .set({ deletedAt: new Date(), deletedByUserId: actor.userId ?? null })
      .where(eq(schema.sandboxTemplates.id, existing.id));
  });
  return { ok: true };
}

/**
 * Atomically promote a template to its environment's default: clear the current
 * default within that environment, then set the target (and reactivate it). One
 * tx; the partial-unique `(workspace_id, environment_id) WHERE is_default` never
 * observes two defaults.
 */
export async function setDefaultTemplate(
  actor: SandboxTemplateActor,
  input: { templateId: string },
): Promise<SandboxTemplateSummary> {
  return withTenantDb(async (tx) => {
    const target = await loadTemplateRow(
      tx,
      actor.workspaceId,
      input.templateId,
    );
    await clearEnvDefaultTx(tx, actor, target.environmentInternalId);
    await tx
      .update(schema.sandboxTemplates)
      .set({
        isDefault: true,
        isActive: true,
        updatedAt: new Date(),
        updatedByUserId: actor.userId ?? null,
      })
      .where(eq(schema.sandboxTemplates.id, target.id));
    return loadTemplateWithTools(tx, actor.workspaceId, target.publicId);
  });
}

export async function setTemplateTools(
  actor: SandboxTemplateActor,
  input: { templateId: string; tools: SandboxTemplateTool[] },
): Promise<SandboxTemplateSummary> {
  return withTenantDb(async (tx) => {
    const existing = await loadTemplateRow(
      tx,
      actor.workspaceId,
      input.templateId,
    );
    await replaceToolsTx(tx, actor, existing.id, input.tools);
    return loadTemplateWithTools(tx, actor.workspaceId, existing.publicId);
  });
}

// ── manifest export / import (portability core) ──────────────────────────────

export async function exportTemplate(
  actor: SandboxTemplateActor,
  input: { templateId: string },
): Promise<SandboxTemplateManifest> {
  const summary = await getTemplate(actor, input);
  // Resolve the selected key public ids back to their env-var NAMES (a manifest
  // travels by name, never by internal id or value).
  const keys = await listSecretKeys({
    orgId: actor.orgId,
    workspaceId: actor.workspaceId,
  });
  let secretKeys: SandboxTemplateManifest["secretKeys"];
  if (summary.secretSelection === "all") {
    secretKeys = keys.map((k) => ({
      key: k.key,
      sensitive: k.sensitive,
      memo: k.memo ?? null,
      required: false,
    }));
  } else {
    const selected = new Set(summary.secretSelection.keyPublicIds);
    secretKeys = keys
      .filter((k) => selected.has(k.id))
      .map((k) => ({
        key: k.key,
        sensitive: k.sensitive,
        memo: k.memo ?? null,
        required: true,
      }));
  }
  return {
    kind: "oxagen.sandbox-template",
    version: 1,
    name: summary.name,
    slug: summary.slug,
    description: summary.description,
    provider: summary.provider,
    runtime: summary.runtime,
    resources: summary.resources,
    network: summary.network,
    secretSelection: summary.secretSelection,
    literalEnv: summary.literalEnv,
    packages: summary.packages,
    tools: summary.tools.map((t) => ({
      kind: t.kind,
      ref: t.ref,
      config: t.config,
    })),
    secretKeys,
  };
}

/**
 * Import a manifest into an environment. Creates a non-default template (unless
 * setAsDefault), its tools, and upserts any MISSING secret keys (names only, no
 * value). Returns warnings for tool refs not installed in the workspace. Slug
 * collision is a hard error unless the caller supplies a `slug` override.
 */
export async function importTemplate(
  actor: SandboxTemplateActor,
  input: {
    environmentId: string;
    manifest: SandboxTemplateManifest;
    slug?: string;
    setAsDefault?: boolean;
  },
): Promise<{ template: SandboxTemplateSummary; warnings: string[] }> {
  const warnings: string[] = [];
  const manifest = input.manifest;
  const slug = (input.slug ?? manifest.slug).toLowerCase();
  if (!isValidEnvironmentSlug(slug)) {
    throw new Error(
      `[sandbox-template] invalid slug: ${input.slug ?? manifest.slug}`,
    );
  }

  // Upsert missing secret keys FIRST (own tx via the vault service) so the
  // secret_selection can reference them. Only create keys not already present —
  // never clobber an existing key's config.
  const existingKeys = await listSecretKeys({
    orgId: actor.orgId,
    workspaceId: actor.workspaceId,
  });
  const existingKeyNames = new Set(existingKeys.map((k) => k.key));
  const keyIdByName = new Map(existingKeys.map((k) => [k.key, k.id]));
  for (const mk of manifest.secretKeys) {
    if (existingKeyNames.has(mk.key)) continue;
    await upsertSecretKey(
      {
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
      },
      { key: mk.key, sensitive: mk.sensitive, memo: mk.memo ?? null },
    );
  }
  // Re-read to pick up public ids for keys just created (for secret_selection).
  if (manifest.secretKeys.some((mk) => !existingKeyNames.has(mk.key))) {
    const refreshed = await listSecretKeys({
      orgId: actor.orgId,
      workspaceId: actor.workspaceId,
    });
    for (const k of refreshed) keyIdByName.set(k.key, k.id);
  }

  // Translate the manifest's secret_selection: 'all' stays 'all'; an explicit
  // selection carries key public ids, which are workspace-local — so resolve the
  // manifest's *names* to this workspace's ids.
  let secretSelection: SandboxSecretSelection = "all";
  if (manifest.secretSelection !== "all") {
    // Manifests reference keys by NAME via secretKeys[]; a required key becomes
    // part of the selection. Fall back to 'all' only if nothing resolved.
    const requiredNames = manifest.secretKeys
      .filter((k) => k.required)
      .map((k) => k.key);
    const ids = requiredNames
      .map((n) => keyIdByName.get(n))
      .filter((v): v is string => typeof v === "string");
    secretSelection = ids.length > 0 ? { keyPublicIds: ids } : "all";
  }

  return withTenantDb(async (tx) => {
    const env = await loadEnvironment(
      tx,
      actor.workspaceId,
      input.environmentId,
    );

    // Slug collision → hard error unless overridden.
    const [collision] = await tx
      .select({ id: schema.sandboxTemplates.id })
      .from(schema.sandboxTemplates)
      .where(
        and(
          eq(schema.sandboxTemplates.workspaceId, actor.workspaceId),
          eq(schema.sandboxTemplates.slug, slug),
          isNull(schema.sandboxTemplates.deletedAt),
        ),
      )
      .limit(1);
    if (collision) {
      throw new Error(
        `[sandbox-template] slug "${slug}" already exists in this workspace — pass a slug override to import`,
      );
    }

    const [row] = await tx
      .insert(schema.sandboxTemplates)
      .values({
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        environmentId: env.id,
        name: manifest.name,
        slug,
        description: manifest.description ?? null,
        isDefault: false,
        isActive: true,
        provider: manifest.provider,
        runtime: manifest.runtime ?? null,
        resources: manifest.resources,
        network: manifest.network,
        secretSelection,
        literalEnv: manifest.literalEnv,
        packages: manifest.packages,
        createdByUserId: actor.userId ?? null,
        updatedByUserId: actor.userId ?? null,
      })
      .returning({
        id: schema.sandboxTemplates.id,
        publicId: schema.sandboxTemplates.publicId,
      });
    if (!row)
      throw new Error("[sandbox-template] import insert returned no row");

    if (manifest.tools.length > 0) {
      await replaceToolsTx(
        tx,
        actor,
        row.id,
        manifest.tools.map((t) => ({
          kind: t.kind,
          ref: t.ref,
          config: t.config,
        })),
      );
      // Advisory: capability refs not installed in this workspace are preloaded
      // best-effort at provision time (skipped with a logged warning).
      for (const t of manifest.tools) {
        warnings.push(
          `tool "${t.kind}:${t.ref}" is referenced by the manifest — it will be preloaded only if installed in this workspace at provision time`,
        );
      }
    }

    if (input.setAsDefault) {
      await clearEnvDefaultTx(tx, actor, env.id);
      await tx
        .update(schema.sandboxTemplates)
        .set({ isDefault: true, isActive: true, updatedAt: new Date() })
        .where(eq(schema.sandboxTemplates.id, row.id));
    }

    const template = await loadTemplateWithTools(
      tx,
      actor.workspaceId,
      row.publicId,
    );
    return { template, warnings };
  });
}

// ── plugin-pack distribution (the third-party story) ─────────────────────────

export interface PackTemplateInstall {
  /** Slug the template landed under (bare or pack-prefixed on collision). */
  slug: string;
  /** Public id of the created/updated template. */
  templateId: string;
  /** false when an existing template was updated in place (idempotent re-install). */
  created: boolean;
}

export interface InstallTemplatesFromPackResult {
  installed: PackTemplateInstall[];
  warnings: string[];
}

/** Derive the pack's slug segment from its id ("ns/slug" → "slug"). */
function packSlugSegment(packId: string): string {
  const seg = packId.includes("/")
    ? packId.slice(packId.lastIndexOf("/") + 1)
    : packId;
  return seg.toLowerCase();
}

/** `${pack}-${slug}`, avoiding a redundant double prefix. */
function prefixedTemplateSlug(packSeg: string, bareSlug: string): string {
  if (bareSlug === packSeg || bareSlug.startsWith(`${packSeg}-`))
    return bareSlug;
  return `${packSeg}-${bareSlug}`;
}

/**
 * Install a plugin pack's declared sandbox templates into the workspace's
 * DEFAULT environment. Each template imports via the same shape as
 * `import_sandbox_template`: non-default, tools preloaded, and any MISSING
 * secret keys upserted by NAME only (never a value). Portability is preserved —
 * an unknown tool ref does not fail the install, it surfaces in `warnings`.
 *
 * Idempotency + collision: the template lands under its bare manifest slug;
 * a re-install of the same pack finds that slug in the default environment and
 * UPDATES it in place (no duplicate). If the bare slug is already taken by an
 * UNRELATED template (one living in a different environment — slugs are unique
 * per workspace), the pack falls back to a pack-namespaced slug so it never
 * clobbers another template. Pack slugs are expected to be distinctive, so a
 * bare-slug match inside the default environment is the pack's own prior install.
 *
 * NOTE: uninstalling the pack does NOT remove these templates — see
 * plugin.org.uninstall. A template may already back a live agent binding, so
 * removal is an explicit, user-driven action, never an uninstall side effect.
 */
export async function installTemplatesFromPack(
  actor: SandboxTemplateActor,
  input: { packId: string; templates: SandboxTemplateManifest[] },
): Promise<InstallTemplatesFromPackResult> {
  const warnings: string[] = [];
  if (input.templates.length === 0) return { installed: [], warnings };

  // Upsert every missing secret key across all templates FIRST (names only, no
  // value), so secret_selection can resolve names → this workspace's key ids.
  const existingKeys = await listSecretKeys({
    orgId: actor.orgId,
    workspaceId: actor.workspaceId,
  });
  const existingKeyNames = new Set(existingKeys.map((k) => k.key));
  const keyIdByName = new Map(existingKeys.map((k) => [k.key, k.id]));
  const seenKeys = new Map<
    string,
    { sensitive: boolean; memo: string | null }
  >();
  for (const tpl of input.templates) {
    for (const mk of tpl.secretKeys) {
      if (existingKeyNames.has(mk.key) || seenKeys.has(mk.key)) continue;
      seenKeys.set(mk.key, { sensitive: mk.sensitive, memo: mk.memo ?? null });
    }
  }
  for (const [key, meta] of seenKeys) {
    await upsertSecretKey(
      {
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
      },
      { key, sensitive: meta.sensitive, memo: meta.memo },
    );
  }
  if (seenKeys.size > 0) {
    const refreshed = await listSecretKeys({
      orgId: actor.orgId,
      workspaceId: actor.workspaceId,
    });
    for (const k of refreshed) keyIdByName.set(k.key, k.id);
  }

  const packSeg = packSlugSegment(input.packId);
  const installed: PackTemplateInstall[] = [];

  await withTenantDb(async (tx) => {
    // Resolve the workspace default environment (the install target).
    const [defaultEnv] = await tx
      .select({ id: schema.environments.id })
      .from(schema.environments)
      .where(
        and(
          eq(schema.environments.workspaceId, actor.workspaceId),
          eq(schema.environments.isDefault, true),
          isNull(schema.environments.deletedAt),
        ),
      )
      .limit(1);
    if (!defaultEnv) {
      throw new Error(
        "[sandbox-template] cannot install pack templates — the workspace has no default environment",
      );
    }

    for (const manifest of input.templates) {
      const bare = manifest.slug.toLowerCase();
      if (!isValidEnvironmentSlug(bare)) {
        throw new Error(
          `[sandbox-template] pack template has invalid slug: ${manifest.slug}`,
        );
      }
      const prefixed = prefixedTemplateSlug(packSeg, bare);

      // Translate the manifest's secret_selection into this workspace's key ids
      // (identical to importTemplate: required keys form an explicit selection).
      let secretSelection: SandboxSecretSelection = "all";
      if (manifest.secretSelection !== "all") {
        const requiredNames = manifest.secretKeys
          .filter((k) => k.required)
          .map((k) => k.key);
        const ids = requiredNames
          .map((n) => keyIdByName.get(n))
          .filter((v): v is string => typeof v === "string");
        secretSelection = ids.length > 0 ? { keyPublicIds: ids } : "all";
      }

      // Find any live template already holding the bare or prefixed slug.
      const rows = await tx
        .select({
          id: schema.sandboxTemplates.id,
          publicId: schema.sandboxTemplates.publicId,
          slug: schema.sandboxTemplates.slug,
          environmentId: schema.sandboxTemplates.environmentId,
        })
        .from(schema.sandboxTemplates)
        .where(
          and(
            eq(schema.sandboxTemplates.workspaceId, actor.workspaceId),
            inArray(schema.sandboxTemplates.slug, [bare, prefixed]),
            isNull(schema.sandboxTemplates.deletedAt),
          ),
        );
      const byBare = rows.find((r) => r.slug === bare);
      const byPrefixed = rows.find((r) => r.slug === prefixed);

      let targetSlug: string;
      let existing: { id: string; publicId: string } | undefined;
      if (byPrefixed) {
        targetSlug = prefixed;
        existing = byPrefixed;
      } else if (byBare && byBare.environmentId === defaultEnv.id) {
        // Bare slug already lives in the default env → this pack's prior install.
        targetSlug = bare;
        existing = byBare;
      } else if (byBare) {
        // Bare slug is taken by an unrelated template in another environment.
        targetSlug = prefixed;
        existing = undefined;
      } else {
        targetSlug = bare;
        existing = undefined;
      }

      const values = {
        name: manifest.name,
        description: manifest.description ?? null,
        provider: manifest.provider,
        runtime: manifest.runtime ?? null,
        resources: manifest.resources,
        network: manifest.network,
        secretSelection,
        literalEnv: manifest.literalEnv,
        packages: manifest.packages,
        isActive: true,
      };

      let templateInternalId: string;
      let publicId: string;
      let created: boolean;
      if (existing) {
        await tx
          .update(schema.sandboxTemplates)
          .set({
            ...values,
            environmentId: defaultEnv.id,
            updatedAt: new Date(),
            updatedByUserId: actor.userId ?? null,
          })
          .where(eq(schema.sandboxTemplates.id, existing.id));
        templateInternalId = existing.id;
        publicId = existing.publicId;
        created = false;
      } else {
        const [row] = await tx
          .insert(schema.sandboxTemplates)
          .values({
            orgId: actor.orgId,
            workspaceId: actor.workspaceId,
            environmentId: defaultEnv.id,
            slug: targetSlug,
            isDefault: false,
            ...values,
            createdByUserId: actor.userId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning({
            id: schema.sandboxTemplates.id,
            publicId: schema.sandboxTemplates.publicId,
          });
        if (!row)
          throw new Error(
            "[sandbox-template] pack template insert returned no row",
          );
        templateInternalId = row.id;
        publicId = row.publicId;
        created = true;
      }

      // Replace the tools set (idempotent) and surface preload advisories.
      await replaceToolsTx(
        tx,
        actor,
        templateInternalId,
        manifest.tools.map((t) => ({
          kind: t.kind,
          ref: t.ref,
          config: t.config,
        })),
      );
      for (const t of manifest.tools) {
        warnings.push(
          `tool "${t.kind}:${t.ref}" from pack "${input.packId}" is preloaded only if installed in this workspace at provision time`,
        );
      }

      installed.push({ slug: targetSlug, templateId: publicId, created });
    }
  });

  return { installed, warnings };
}

// ── agent-environment bindings ────────────────────────────────────────────────

// Per-call for the same reason as templateColumns() — no schema access at import.
const bindingColumns = () =>
  ({
    id: schema.agentEnvironmentBindings.id,
    publicId: schema.agentEnvironmentBindings.publicId,
    agentId: schema.agentEnvironmentBindings.agentId,
    environmentInternalId: schema.agentEnvironmentBindings.environmentId,
    sandboxTemplateInternalId:
      schema.agentEnvironmentBindings.sandboxTemplateId,
    isPrimary: schema.agentEnvironmentBindings.isPrimary,
  }) as const;

async function bindingSummary(
  tx: Tx,
  workspaceId: string,
  row: {
    publicId: string;
    agentId: string;
    environmentInternalId: string;
    sandboxTemplateInternalId: string | null;
    isPrimary: boolean;
  },
): Promise<AgentEnvironmentBinding> {
  const [env] = await tx
    .select({
      publicId: schema.environments.publicId,
      name: schema.environments.name,
      slug: schema.environments.slug,
    })
    .from(schema.environments)
    .where(eq(schema.environments.id, row.environmentInternalId))
    .limit(1);
  let templatePublicId: string | null = null;
  let templateName: string | null = null;
  if (row.sandboxTemplateInternalId) {
    const [tpl] = await tx
      .select({
        publicId: schema.sandboxTemplates.publicId,
        name: schema.sandboxTemplates.name,
      })
      .from(schema.sandboxTemplates)
      .where(eq(schema.sandboxTemplates.id, row.sandboxTemplateInternalId))
      .limit(1);
    templatePublicId = tpl?.publicId ?? null;
    templateName = tpl?.name ?? null;
  }
  return {
    id: row.publicId,
    agentId: row.agentId,
    environmentId: env?.publicId ?? row.environmentInternalId,
    environmentName: env?.name ?? "",
    environmentSlug: env?.slug ?? "",
    sandboxTemplateId: templatePublicId,
    sandboxTemplateName: templateName,
    isPrimary: row.isPrimary,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an agent identifier (internal UUID, `agt_…` public id, or slug) to
 * the internal UUID — `agent_environment_bindings.agent_id` is a uuid column,
 * and callers (the app UI, MCP tools) hold the PUBLIC id, so passing the raw
 * identifier through made every bind/unbind/list query throw at the driver.
 */
async function resolveAgentInternalId(
  tx: Tx,
  workspaceId: string,
  identifier: string,
): Promise<string> {
  if (UUID_RE.test(identifier)) return identifier;
  const match = identifier.startsWith("agt_")
    ? eq(schema.agents.publicId, identifier)
    : eq(schema.agents.slug, identifier);
  const [row] = await tx
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        match,
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(`[sandbox-template] agent not found: ${identifier}`);
  return row.id;
}

export async function bindAgentEnvironment(
  actor: SandboxTemplateActor,
  input: {
    agentId: string;
    environmentId: string;
    sandboxTemplateId?: string | null;
    isPrimary?: boolean;
  },
): Promise<AgentEnvironmentBinding> {
  return withTenantDb(async (tx) => {
    const agentInternalId = await resolveAgentInternalId(
      tx,
      actor.workspaceId,
      input.agentId,
    );
    const env = await loadEnvironment(
      tx,
      actor.workspaceId,
      input.environmentId,
    );

    // A named template must belong to the same environment as the binding.
    let templateInternalId: string | null = null;
    if (input.sandboxTemplateId) {
      const tpl = await loadTemplateRow(
        tx,
        actor.workspaceId,
        input.sandboxTemplateId,
      );
      if (tpl.environmentInternalId !== env.id) {
        throw new Error(
          "[sandbox-template] bound template must belong to the bound environment",
        );
      }
      templateInternalId = tpl.id;
    }

    // Does the agent already have any binding? First binding becomes primary
    // unless the caller says otherwise.
    const existingForAgent = await tx
      .select({
        id: schema.agentEnvironmentBindings.id,
        environmentInternalId: schema.agentEnvironmentBindings.environmentId,
        isPrimary: schema.agentEnvironmentBindings.isPrimary,
      })
      .from(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
        ),
      );
    const agentHasPrimary = existingForAgent.some((b) => b.isPrimary);
    const desiredPrimary = input.isPrimary ?? !agentHasPrimary;

    // Promote atomically: demote the agent's current primary before setting this one.
    if (desiredPrimary) {
      await tx
        .update(schema.agentEnvironmentBindings)
        .set({
          isPrimary: false,
          updatedAt: new Date(),
          updatedByUserId: actor.userId ?? null,
        })
        .where(
          and(
            eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
            eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
            eq(schema.agentEnvironmentBindings.isPrimary, true),
          ),
        );
    }

    const existing = existingForAgent.find(
      (b) => b.environmentInternalId === env.id,
    );
    let publicId: string;
    if (existing) {
      const [updated] = await tx
        .update(schema.agentEnvironmentBindings)
        .set({
          sandboxTemplateId: templateInternalId,
          isPrimary: desiredPrimary,
          updatedAt: new Date(),
          updatedByUserId: actor.userId ?? null,
        })
        .where(eq(schema.agentEnvironmentBindings.id, existing.id))
        .returning({ publicId: schema.agentEnvironmentBindings.publicId });
      publicId = updated!.publicId;
    } else {
      const [inserted] = await tx
        .insert(schema.agentEnvironmentBindings)
        .values({
          orgId: actor.orgId,
          workspaceId: actor.workspaceId,
          agentId: agentInternalId,
          environmentId: env.id,
          sandboxTemplateId: templateInternalId,
          isPrimary: desiredPrimary,
          createdByUserId: actor.userId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning({ publicId: schema.agentEnvironmentBindings.publicId });
      publicId = inserted!.publicId;
    }

    const [row] = await tx
      .select(bindingColumns())
      .from(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.publicId, publicId),
        ),
      )
      .limit(1);
    return bindingSummary(tx, actor.workspaceId, row!);
  });
}

export async function unbindAgentEnvironment(
  actor: SandboxTemplateActor,
  input: { agentId: string; environmentId: string },
): Promise<{ ok: true }> {
  await withTenantDb(async (tx) => {
    const agentInternalId = await resolveAgentInternalId(
      tx,
      actor.workspaceId,
      input.agentId,
    );
    const env = await loadEnvironment(
      tx,
      actor.workspaceId,
      input.environmentId,
    );
    await tx
      .delete(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
          eq(schema.agentEnvironmentBindings.environmentId, env.id),
        ),
      );
  });
  return { ok: true };
}

export async function listAgentBindings(
  actor: SandboxTemplateActor,
  input: { agentId: string },
): Promise<AgentEnvironmentBinding[]> {
  return withTenantDb(async (tx) => {
    const agentInternalId = await resolveAgentInternalId(
      tx,
      actor.workspaceId,
      input.agentId,
    );
    const rows = await tx
      .select(bindingColumns())
      .from(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
        ),
      );
    return Promise.all(
      rows.map((r) => bindingSummary(tx, actor.workspaceId, r)),
    );
  });
}

// ── run-time resolution ───────────────────────────────────────────────────────

/**
 * Resolve which environment + sandbox template a run should use.
 *
 * An explicit `sandboxTemplateId` short-circuits the chain: that exact template
 * (and its own environment) is used. Otherwise the environment resolves as
 * explicit environmentId → the agent's PRIMARY binding → the workspace default
 * environment, and the template as the resolved binding's template (if any) →
 * the environment's default template. Both the environment and the template must
 * be active; each failure raises a clear preflight error.
 */
export async function resolveSandboxTemplateForRun(
  actor: SandboxTemplateActor,
  input: {
    agentId?: string;
    environmentId?: string;
    sandboxTemplateId?: string;
  } = {},
): Promise<ResolvedSandboxTemplate> {
  return withTenantDb(async (tx) => {
    const agentInternalId = input.agentId
      ? await resolveAgentInternalId(tx, actor.workspaceId, input.agentId)
      : null;
    // 0. Explicit template pin — a caller (or template-driven run) that already
    // chose a template. Its own environment governs secret resolution.
    if (input.sandboxTemplateId) {
      const row = await loadTemplateRow(
        tx,
        actor.workspaceId,
        input.sandboxTemplateId,
      );
      const pinnedEnv = await loadEnvironment(
        tx,
        actor.workspaceId,
        row.environmentPublicId,
      );
      if (!pinnedEnv.isActive) {
        throw new Error(
          `[sandbox-template] environment "${pinnedEnv.slug}" is inactive — activate it or choose another`,
        );
      }
      const template = await loadTemplateWithTools(
        tx,
        actor.workspaceId,
        row.publicId,
      );
      if (!template.isActive) {
        throw new Error(
          `[sandbox-template] template "${template.slug}" is inactive — activate it or promote another default`,
        );
      }
      return {
        environment: {
          id: row.environmentPublicId,
          name: pinnedEnv.name,
          slug: pinnedEnv.slug,
        },
        template,
      };
    }

    // 1. Resolve the environment (internal row).
    let envRow: {
      id: string;
      name: string;
      slug: string;
      isActive: boolean;
    } | null = null;
    let bindingTemplateInternalId: string | null = null;

    if (input.environmentId) {
      envRow = await loadEnvironment(
        tx,
        actor.workspaceId,
        input.environmentId,
      );
      // A binding for (agent, this env) may still pin a specific template.
      if (agentInternalId) {
        const [b] = await tx
          .select({
            sandboxTemplateId:
              schema.agentEnvironmentBindings.sandboxTemplateId,
          })
          .from(schema.agentEnvironmentBindings)
          .where(
            and(
              eq(
                schema.agentEnvironmentBindings.workspaceId,
                actor.workspaceId,
              ),
              eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
              eq(schema.agentEnvironmentBindings.environmentId, envRow.id),
            ),
          )
          .limit(1);
        bindingTemplateInternalId = b?.sandboxTemplateId ?? null;
      }
    } else if (agentInternalId) {
      const [primary] = await tx
        .select({
          environmentInternalId: schema.agentEnvironmentBindings.environmentId,
          sandboxTemplateId: schema.agentEnvironmentBindings.sandboxTemplateId,
        })
        .from(schema.agentEnvironmentBindings)
        .where(
          and(
            eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
            eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
            eq(schema.agentEnvironmentBindings.isPrimary, true),
          ),
        )
        .limit(1);
      if (primary) {
        const [e] = await tx
          .select({
            id: schema.environments.id,
            name: schema.environments.name,
            slug: schema.environments.slug,
            isActive: schema.environments.isActive,
          })
          .from(schema.environments)
          .where(
            and(
              eq(schema.environments.id, primary.environmentInternalId),
              isNull(schema.environments.deletedAt),
            ),
          )
          .limit(1);
        envRow = e ?? null;
        bindingTemplateInternalId = primary.sandboxTemplateId ?? null;
      }
    }

    // Fall back to the workspace default environment.
    if (!envRow) {
      const [e] = await tx
        .select({
          id: schema.environments.id,
          name: schema.environments.name,
          slug: schema.environments.slug,
          isActive: schema.environments.isActive,
        })
        .from(schema.environments)
        .where(
          and(
            eq(schema.environments.workspaceId, actor.workspaceId),
            eq(schema.environments.isDefault, true),
            isNull(schema.environments.deletedAt),
          ),
        )
        .limit(1);
      if (!e) {
        throw new Error(
          "[sandbox-template] no environment to run in — pass environmentId, bind the agent, or set a workspace default environment",
        );
      }
      envRow = e;
    }

    if (!envRow.isActive) {
      throw new Error(
        `[sandbox-template] environment "${envRow.slug}" is inactive — activate it or choose another`,
      );
    }

    // 2. Resolve the template: binding's template → environment default.
    let templatePublicId: string;
    if (bindingTemplateInternalId) {
      const [t] = await tx
        .select({
          publicId: schema.sandboxTemplates.publicId,
          isActive: schema.sandboxTemplates.isActive,
        })
        .from(schema.sandboxTemplates)
        .where(
          and(
            eq(schema.sandboxTemplates.id, bindingTemplateInternalId),
            isNull(schema.sandboxTemplates.deletedAt),
          ),
        )
        .limit(1);
      if (!t) {
        throw new Error(
          "[sandbox-template] bound template was deleted — rebind or clear the binding",
        );
      }
      templatePublicId = t.publicId;
    } else {
      const [t] = await tx
        .select({ publicId: schema.sandboxTemplates.publicId })
        .from(schema.sandboxTemplates)
        .where(
          and(
            eq(schema.sandboxTemplates.workspaceId, actor.workspaceId),
            eq(schema.sandboxTemplates.environmentId, envRow.id),
            eq(schema.sandboxTemplates.isDefault, true),
            isNull(schema.sandboxTemplates.deletedAt),
          ),
        )
        .limit(1);
      if (!t) {
        throw new Error(
          `[sandbox-template] environment "${envRow.slug}" has no default sandbox template — create one and set it as default`,
        );
      }
      templatePublicId = t.publicId;
    }

    const template = await loadTemplateWithTools(
      tx,
      actor.workspaceId,
      templatePublicId,
    );
    if (!template.isActive) {
      throw new Error(
        `[sandbox-template] template "${template.slug}" is inactive — activate it or promote another default`,
      );
    }

    // template.environmentId is the resolved environment's PUBLIC id (the
    // template lives in envRow's environment — guaranteed by binding/default).
    return {
      environment: {
        id: template.environmentId,
        name: envRow.name,
        slug: envRow.slug,
      },
      template,
    };
  });
}
