/**
 * Workspace credential vault (Spec §7). Keys live at the workspace root with a
 * `sensitive` flag (default true) and a default value; values are overridden
 * per environment. Sensitive values are envelope-encrypted via @oxagen/crypto;
 * non-sensitive values are plaintext config. Resolution: override ?? default.
 *
 * Every read/write is RLS-enforced through withTenantDb (the kernel establishes
 * the tenant scope for scoped capabilities, kernel.ts:528). NEVER log plaintext
 * values — lifecycle logging happens at the handler boundary with key names and
 * counts only.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { decrypt, encrypt } from "@oxagen/crypto";
import { schema, withTenantDb } from "@oxagen/database";
import type { ResolvedKms } from "../credentials/kms";
import { resolveVaultKms, VaultLockedError } from "./vault-kms";
import { isValidSecretKeyName, parseEnvText } from "./env-parse";

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

export interface VaultActor {
  orgId: string;
  workspaceId: string;
  userId?: string | null;
  requestId?: string | null;
}

// ── crypto helpers ────────────────────────────────────────────────────────────

async function encOne(value: string, kms: ResolvedKms): Promise<Buffer> {
  return encrypt(value, kms.keyId, { adapter: kms.adapter });
}

async function decOne(buf: Buffer, keyId: string, kms: ResolvedKms): Promise<string> {
  return (await decrypt(buf, keyId, { adapter: kms.adapter })).toString("utf8");
}

// Column shape for a key's default value (one of enc/text populated per sensitive).
interface ValueColumns {
  enc: Buffer | null;
  text: string | null;
  kmsKeyId: string | null;
}

async function valueColumns(
  plaintext: string | null,
  sensitive: boolean,
  kms: ResolvedKms | null,
): Promise<ValueColumns> {
  if (plaintext === null) return { enc: null, text: null, kmsKeyId: null };
  if (sensitive) {
    if (!kms) throw new VaultLockedError();
    return { enc: await encOne(plaintext, kms), text: null, kmsKeyId: kms.keyId };
  }
  return { enc: null, text: plaintext, kmsKeyId: null };
}

// ── value resolution ──────────────────────────────────────────────────────────

interface KeyRow {
  id: string;
  publicId: string;
  key: string;
  sensitive: boolean;
  memo: string | null;
  defaultValueEnc: Buffer | null;
  defaultValueText: string | null;
  defaultValueKmsKeyId: string | null;
}

interface ValueRow {
  valueEnc: Buffer | null;
  valueText: string | null;
  valueKmsKeyId: string | null;
}

export type ResolvedSource = "override" | "default" | "unset";

export interface ResolvedSecret {
  value: string | null;
  source: ResolvedSource;
}

/** Resolve value(key, env) = override ?? default ?? unset, decrypting as needed. */
async function resolveOne(
  key: KeyRow,
  value: ValueRow | undefined,
  kms: ResolvedKms | null,
): Promise<ResolvedSecret> {
  if (value && (value.valueEnc !== null || value.valueText !== null)) {
    if (key.sensitive) {
      if (!kms) throw new VaultLockedError();
      const plain = await decOne(value.valueEnc as Buffer, value.valueKmsKeyId ?? kms.keyId, kms);
      return { value: plain, source: "override" };
    }
    return { value: value.valueText, source: "override" };
  }
  if (key.sensitive ? key.defaultValueEnc !== null : key.defaultValueText !== null) {
    if (key.sensitive) {
      if (!kms) throw new VaultLockedError();
      const plain = await decOne(
        key.defaultValueEnc as Buffer,
        key.defaultValueKmsKeyId ?? kms.keyId,
        kms,
      );
      return { value: plain, source: "default" };
    }
    return { value: key.defaultValueText, source: "default" };
  }
  return { value: null, source: "unset" };
}

/** Current plaintext default of a key (for re-encode on a sensitive toggle). */
async function existingDefaultPlaintext(
  row: KeyRow,
  kms: ResolvedKms | null,
): Promise<string | null> {
  if (row.sensitive) {
    if (row.defaultValueEnc === null) return null;
    if (!kms) throw new VaultLockedError();
    return decOne(row.defaultValueEnc, row.defaultValueKmsKeyId ?? kms.keyId, kms);
  }
  return row.defaultValueText;
}

// Built per call, never at module scope: test suites mock @oxagen/database
// with a partial `schema`, and a module-level `schema.<table>.<col>` access
// crashes every importer at load time.
const keyColumns = () =>
  ({
    id: schema.secretKeys.id,
    publicId: schema.secretKeys.publicId,
    key: schema.secretKeys.key,
    sensitive: schema.secretKeys.sensitive,
    memo: schema.secretKeys.memo,
    defaultValueEnc: schema.secretKeys.defaultValueEnc,
    defaultValueText: schema.secretKeys.defaultValueText,
    defaultValueKmsKeyId: schema.secretKeys.defaultValueKmsKeyId,
  }) as const;

async function loadKeyByPublicId(tx: Tx, workspaceId: string, publicId: string): Promise<KeyRow> {
  const [row] = await tx
    .select(keyColumns())
    .from(schema.secretKeys)
    .where(
      and(
        eq(schema.secretKeys.workspaceId, workspaceId),
        eq(schema.secretKeys.publicId, publicId),
        isNull(schema.secretKeys.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`[vault] secret key not found: ${publicId}`);
  return row;
}

async function loadEnvironmentId(tx: Tx, workspaceId: string, publicId: string): Promise<string> {
  const [row] = await tx
    .select({ id: schema.environments.id })
    .from(schema.environments)
    .where(
      and(
        eq(schema.environments.workspaceId, workspaceId),
        eq(schema.environments.publicId, publicId),
        isNull(schema.environments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`[vault] environment not found: ${publicId}`);
  return row.id;
}

// ── key upsert (tx core + public) ───────────────────────────────────────────

export interface UpsertSecretKeyInput {
  key: string;
  sensitive: boolean;
  memo?: string | null;
  /** undefined = leave default unchanged; null = clear; string = set. */
  defaultValue?: string | null;
}

async function upsertSecretKeyTx(
  tx: Tx,
  actor: VaultActor,
  input: UpsertSecretKeyInput,
  kms: ResolvedKms | null,
): Promise<{ id: string }> {
  if (!isValidSecretKeyName(input.key)) {
    throw new Error(`[vault] invalid secret key name: ${input.key}`);
  }
  const [existing] = await tx
    .select(keyColumns())
    .from(schema.secretKeys)
    .where(
      and(
        eq(schema.secretKeys.workspaceId, actor.workspaceId),
        eq(schema.secretKeys.key, input.key),
        isNull(schema.secretKeys.deletedAt),
      ),
    )
    .limit(1);

  // Decide the plaintext default to store. When `sensitive` toggles and the
  // caller did not pass a new default, re-encode the existing default into the
  // new storage so the DB storage check never trips and no value is lost.
  let plaintext: string | null | undefined = input.defaultValue;
  if (existing && plaintext === undefined && existing.sensitive !== input.sensitive) {
    plaintext = await existingDefaultPlaintext(existing, kms);
  }

  const cols =
    plaintext === undefined
      ? null // preserve existing default columns (sensitive unchanged)
      : await valueColumns(plaintext, input.sensitive, kms);

  if (existing) {
    await tx
      .update(schema.secretKeys)
      .set({
        sensitive: input.sensitive,
        memo: input.memo === undefined ? existing.memo : input.memo,
        ...(cols
          ? {
              defaultValueEnc: cols.enc,
              defaultValueText: cols.text,
              defaultValueKmsKeyId: cols.kmsKeyId,
            }
          : {}),
        updatedAt: new Date(),
        updatedByUserId: actor.userId ?? null,
      })
      .where(eq(schema.secretKeys.id, existing.id));
    return { id: existing.publicId };
  }

  const insertCols = cols ?? { enc: null, text: null, kmsKeyId: null };
  const [row] = await tx
    .insert(schema.secretKeys)
    .values({
      orgId: actor.orgId,
      workspaceId: actor.workspaceId,
      key: input.key,
      sensitive: input.sensitive,
      memo: input.memo ?? null,
      defaultValueEnc: insertCols.enc,
      defaultValueText: insertCols.text,
      defaultValueKmsKeyId: insertCols.kmsKeyId,
      createdByUserId: actor.userId ?? null,
      updatedByUserId: actor.userId ?? null,
    })
    .returning({ publicId: schema.secretKeys.publicId });
  if (!row) throw new Error("[vault] secret key insert returned no row");
  return { id: row.publicId };
}

export async function upsertSecretKey(
  actor: VaultActor,
  input: UpsertSecretKeyInput,
): Promise<{ id: string }> {
  const kms = resolveVaultKms();
  return withTenantDb((tx) => upsertSecretKeyTx(tx, actor, input, kms));
}

// ── value set / unset ─────────────────────────────────────────────────────────

async function setSecretValueTx(
  tx: Tx,
  actor: VaultActor,
  input: { keyId: string; environmentId: string; value: string },
  kms: ResolvedKms | null,
): Promise<void> {
  const key = await loadKeyByPublicId(tx, actor.workspaceId, input.keyId);
  const environmentId = await loadEnvironmentId(tx, actor.workspaceId, input.environmentId);
  const cols = await valueColumns(input.value, key.sensitive, kms);
  await tx
    .insert(schema.secretValues)
    .values({
      orgId: actor.orgId,
      workspaceId: actor.workspaceId,
      secretKeyId: key.id,
      environmentId,
      valueEnc: cols.enc,
      valueText: cols.text,
      valueKmsKeyId: cols.kmsKeyId,
      createdByUserId: actor.userId ?? null,
      updatedByUserId: actor.userId ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.secretValues.secretKeyId, schema.secretValues.environmentId],
      set: {
        valueEnc: cols.enc,
        valueText: cols.text,
        valueKmsKeyId: cols.kmsKeyId,
        updatedAt: new Date(),
        updatedByUserId: actor.userId ?? null,
      },
    });
}

export async function setSecretValue(
  actor: VaultActor,
  input: { keyId: string; environmentId: string; value: string },
): Promise<{ ok: true }> {
  const kms = resolveVaultKms();
  await withTenantDb((tx) => setSecretValueTx(tx, actor, input, kms));
  return { ok: true };
}

export async function unsetSecretValue(
  actor: VaultActor,
  input: { keyId: string; environmentId: string },
): Promise<{ ok: true }> {
  await withTenantDb(async (tx) => {
    const key = await loadKeyByPublicId(tx, actor.workspaceId, input.keyId);
    const environmentId = await loadEnvironmentId(tx, actor.workspaceId, input.environmentId);
    await tx
      .delete(schema.secretValues)
      .where(
        and(
          eq(schema.secretValues.secretKeyId, key.id),
          eq(schema.secretValues.environmentId, environmentId),
        ),
      );
  });
  return { ok: true };
}

// ── list (masked) / delete ──────────────────────────────────────────────────

export interface SecretKeySummary {
  id: string;
  key: string;
  sensitive: boolean;
  memo: string | null;
  hasDefault: boolean;
  /** environment public ids that carry an override for this key. */
  overrideEnvironmentIds: string[];
}

export async function listSecretKeys(actor: VaultActor): Promise<SecretKeySummary[]> {
  return withTenantDb(async (tx) => {
    const keys = await tx
      .select(keyColumns())
      .from(schema.secretKeys)
      .where(
        and(
          eq(schema.secretKeys.workspaceId, actor.workspaceId),
          isNull(schema.secretKeys.deletedAt),
        ),
      )
      .orderBy(schema.secretKeys.key);
    if (keys.length === 0) return [];

    const envs = await tx
      .select({ id: schema.environments.id, publicId: schema.environments.publicId })
      .from(schema.environments)
      .where(
        and(
          eq(schema.environments.workspaceId, actor.workspaceId),
          isNull(schema.environments.deletedAt),
        ),
      );
    const envPublicById = new Map(envs.map((e) => [e.id, e.publicId]));

    // Single batched read of every override row for this workspace (no N+1).
    const values = await tx
      .select({
        secretKeyId: schema.secretValues.secretKeyId,
        environmentId: schema.secretValues.environmentId,
      })
      .from(schema.secretValues)
      .where(eq(schema.secretValues.workspaceId, actor.workspaceId));
    const overridesByKey = new Map<string, string[]>();
    for (const v of values) {
      const envPublic = envPublicById.get(v.environmentId);
      if (!envPublic) continue;
      const list = overridesByKey.get(v.secretKeyId) ?? [];
      list.push(envPublic);
      overridesByKey.set(v.secretKeyId, list);
    }

    return keys.map((k) => ({
      id: k.publicId,
      key: k.key,
      sensitive: k.sensitive,
      memo: k.memo,
      hasDefault: k.sensitive ? k.defaultValueEnc !== null : k.defaultValueText !== null,
      overrideEnvironmentIds: overridesByKey.get(k.id) ?? [],
    }));
  });
}

export async function deleteSecretKey(
  actor: VaultActor,
  input: { keyId: string },
): Promise<{ ok: true }> {
  await withTenantDb(async (tx) => {
    const key = await loadKeyByPublicId(tx, actor.workspaceId, input.keyId);
    // Hard-remove overrides; soft-delete the key (audit trail on the key row).
    await tx.delete(schema.secretValues).where(eq(schema.secretValues.secretKeyId, key.id));
    await tx
      .update(schema.secretKeys)
      .set({ deletedAt: new Date(), deletedByUserId: actor.userId ?? null })
      .where(eq(schema.secretKeys.id, key.id));
  });
  return { ok: true };
}

// ── reveal / export (audited; Spec §7.3) ──────────────────────────────────────

async function writeAccessLog(
  tx: Tx,
  actor: VaultActor,
  action: "reveal" | "export",
  scope: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.secretAccessLog).values({
    orgId: actor.orgId,
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId ?? null,
    action,
    scope,
    requestId: actor.requestId ?? null,
  });
}

export interface RevealResult {
  key: string;
  value: string | null;
  source: ResolvedSource;
}

export async function revealSecret(
  actor: VaultActor,
  input: { keyId: string; environmentId?: string | null },
): Promise<RevealResult> {
  const kms = resolveVaultKms();
  return withTenantDb(async (tx) => {
    const key = await loadKeyByPublicId(tx, actor.workspaceId, input.keyId);
    let value: ValueRow | undefined;
    if (input.environmentId) {
      const environmentId = await loadEnvironmentId(tx, actor.workspaceId, input.environmentId);
      const [v] = await tx
        .select({
          valueEnc: schema.secretValues.valueEnc,
          valueText: schema.secretValues.valueText,
          valueKmsKeyId: schema.secretValues.valueKmsKeyId,
        })
        .from(schema.secretValues)
        .where(
          and(
            eq(schema.secretValues.secretKeyId, key.id),
            eq(schema.secretValues.environmentId, environmentId),
          ),
        )
        .limit(1);
      value = v;
    }
    const resolved = await resolveOne(key, value, kms);
    await writeAccessLog(tx, actor, "reveal", {
      keyPublicIds: [input.keyId],
      environmentId: input.environmentId ?? null,
      count: 1,
    });
    return { key: key.key, value: resolved.value, source: resolved.source };
  });
}

export interface ExportResult {
  env: Array<{ key: string; value: string }>;
  dotenv: string;
}

export async function exportSecrets(
  actor: VaultActor,
  input: { environmentId?: string | null; keyIds?: string[] | null },
): Promise<ExportResult> {
  const kms = resolveVaultKms();
  return withTenantDb(async (tx) => {
    const keyFilters = [
      eq(schema.secretKeys.workspaceId, actor.workspaceId),
      isNull(schema.secretKeys.deletedAt),
    ];
    if (input.keyIds && input.keyIds.length > 0) {
      keyFilters.push(inArray(schema.secretKeys.publicId, input.keyIds));
    }
    const keys = await tx
      .select(keyColumns())
      .from(schema.secretKeys)
      .where(and(...keyFilters))
      .orderBy(schema.secretKeys.key);

    let valuesByKeyId = new Map<string, ValueRow>();
    if (input.environmentId) {
      const environmentId = await loadEnvironmentId(tx, actor.workspaceId, input.environmentId);
      const rows = await tx
        .select({
          secretKeyId: schema.secretValues.secretKeyId,
          valueEnc: schema.secretValues.valueEnc,
          valueText: schema.secretValues.valueText,
          valueKmsKeyId: schema.secretValues.valueKmsKeyId,
        })
        .from(schema.secretValues)
        .where(eq(schema.secretValues.environmentId, environmentId));
      valuesByKeyId = new Map(rows.map((r) => [r.secretKeyId, r]));
    }

    const env: Array<{ key: string; value: string }> = [];
    for (const key of keys) {
      const resolved = await resolveOne(key, valuesByKeyId.get(key.id), kms);
      if (resolved.source !== "unset" && resolved.value !== null) {
        env.push({ key: key.key, value: resolved.value });
      }
    }
    const dotenv = env.map((e) => `${e.key}=${renderEnvValue(e.value)}`).join("\n") + "\n";

    await writeAccessLog(tx, actor, "export", {
      environmentId: input.environmentId ?? null,
      keyPublicIds: input.keyIds ?? null,
      count: env.length,
    });
    return { env, dotenv };
  });
}

/** Quote a value for `.env` output so it round-trips through parseEnvText. */
function renderEnvValue(value: string): string {
  if (value !== "" && !/[\s#"'=]/.test(value)) return value;
  // Single quotes are literal in our parser; prefer them when safe.
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/"/g, '\\"')}"`;
}

// ── `.env` import (preview + commit) ──────────────────────────────────────────

export interface ImportPreviewRow {
  key: string;
  isNewKey: boolean;
  sensitive: boolean;
  target: "default" | "override";
  willOverride: boolean;
}

export interface ImportEnvResult {
  rows: ImportPreviewRow[];
  committed: boolean;
}

export async function importEnv(
  actor: VaultActor,
  input: { environmentId?: string | null; text: string; commit: boolean },
): Promise<ImportEnvResult> {
  const entries = parseEnvText(input.text);
  const kms = resolveVaultKms();
  return withTenantDb(async (tx) => {
    const existingKeys = await tx
      .select({
        id: schema.secretKeys.id,
        key: schema.secretKeys.key,
        sensitive: schema.secretKeys.sensitive,
        defaultValueEnc: schema.secretKeys.defaultValueEnc,
        defaultValueText: schema.secretKeys.defaultValueText,
      })
      .from(schema.secretKeys)
      .where(
        and(
          eq(schema.secretKeys.workspaceId, actor.workspaceId),
          isNull(schema.secretKeys.deletedAt),
        ),
      );
    const byKeyName = new Map(existingKeys.map((k) => [k.key, k]));

    // For override targets, which keys already have a value in the target env.
    const overriddenKeyIds = new Set<string>();
    if (input.environmentId) {
      const environmentId = await loadEnvironmentId(tx, actor.workspaceId, input.environmentId);
      const rows = await tx
        .select({ secretKeyId: schema.secretValues.secretKeyId })
        .from(schema.secretValues)
        .where(eq(schema.secretValues.environmentId, environmentId));
      for (const r of rows) overriddenKeyIds.add(r.secretKeyId);
    }

    const target: "default" | "override" = input.environmentId ? "override" : "default";
    const rows: ImportPreviewRow[] = entries.map((e) => {
      const existing = byKeyName.get(e.key);
      const isNewKey = !existing;
      const sensitive = existing?.sensitive ?? true; // new keys default sensitive
      const willOverride =
        target === "override"
          ? existing
            ? overriddenKeyIds.has(existing.id)
            : false
          : existing
            ? (existing.sensitive ? existing.defaultValueEnc !== null : existing.defaultValueText !== null)
            : false;
      return { key: e.key, isNewKey, sensitive, target, willOverride };
    });

    if (input.commit) {
      for (const e of entries) {
        const existing = byKeyName.get(e.key);
        const sensitive = existing?.sensitive ?? true;
        if (target === "default") {
          await upsertSecretKeyTx(tx, actor, { key: e.key, sensitive, defaultValue: e.value }, kms);
        } else {
          // Ensure the key exists (preserving its sensitivity), then set the override.
          await upsertSecretKeyTx(tx, actor, { key: e.key, sensitive }, kms);
          const keyRow = await loadKeyByKeyName(tx, actor.workspaceId, e.key);
          await setSecretValueTx(
            tx,
            actor,
            { keyId: keyRow.publicId, environmentId: input.environmentId!, value: e.value },
            kms,
          );
        }
      }
    }

    return { rows, committed: input.commit };
  });
}

async function loadKeyByKeyName(
  tx: Tx,
  workspaceId: string,
  key: string,
): Promise<{ publicId: string }> {
  const [row] = await tx
    .select({ publicId: schema.secretKeys.publicId })
    .from(schema.secretKeys)
    .where(
      and(
        eq(schema.secretKeys.workspaceId, workspaceId),
        eq(schema.secretKeys.key, key),
        isNull(schema.secretKeys.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`[vault] secret key not found after upsert: ${key}`);
  return row;
}

// ── provisioning reuse (Spec §11/§12) ─────────────────────────────────────────

/**
 * A sandbox-template secret selection: every live key ('all') or an explicit
 * allow-list of key public ids. Mirrors the contract's SandboxSecretSelection
 * (kept structurally local so the vault service takes no contract dependency).
 */
export type SecretSelection = "all" | { keyPublicIds: string[] };

/**
 * Resolve the full key→value env map for an environment (override ?? default),
 * skipping unset keys, decrypting sensitive values. Used by the sandbox
 * provisioner and connector workers to inject the trusted vault env. This is
 * system injection into an ephemeral sandbox (not a human reveal), so it is NOT
 * access-logged — the run itself is metered. Callers outside a scoped handler
 * (e.g. Inngest steps) MUST wrap this in runInTenantScope.
 *
 * `selection` filters which keys resolve (Spec §5.2 secret_selection): 'all'
 * (default) resolves every live key; `{ keyPublicIds }` resolves only those
 * keys. A public id in the selection that no longer exists is silently skipped.
 */
export async function resolveEnvironmentSecrets(actor: {
  orgId: string;
  workspaceId: string;
  environmentId: string;
  selection?: SecretSelection;
}): Promise<Record<string, string>> {
  const kms = resolveVaultKms();
  const selection = actor.selection ?? "all";
  return withTenantDb(async (tx) => {
    const environmentId = await loadEnvironmentId(tx, actor.workspaceId, actor.environmentId);
    const allKeys = await tx
      .select(keyColumns())
      .from(schema.secretKeys)
      .where(
        and(
          eq(schema.secretKeys.workspaceId, actor.workspaceId),
          isNull(schema.secretKeys.deletedAt),
        ),
      );
    const keys =
      selection === "all"
        ? allKeys
        : allKeys.filter((k) => selection.keyPublicIds.includes(k.publicId));
    const rows = await tx
      .select({
        secretKeyId: schema.secretValues.secretKeyId,
        valueEnc: schema.secretValues.valueEnc,
        valueText: schema.secretValues.valueText,
        valueKmsKeyId: schema.secretValues.valueKmsKeyId,
      })
      .from(schema.secretValues)
      .where(eq(schema.secretValues.environmentId, environmentId));
    const valuesByKeyId = new Map(rows.map((r) => [r.secretKeyId, r]));

    const out: Record<string, string> = {};
    for (const key of keys) {
      const resolved = await resolveOne(key, valuesByKeyId.get(key.id), kms);
      if (resolved.source !== "unset" && resolved.value !== null) out[key.key] = resolved.value;
    }
    return out;
  });
}
