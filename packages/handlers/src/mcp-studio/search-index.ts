// search-index.ts: the Postgres side of a workspace's search index (lane
// M15; mcp-studio-spec, Large servers; ADR-217).
//
// It reads the workspace's [embeddings] setting from workspaces.settings,
// builds the embedder that setting names, and keeps vectors in
// mcp.search_embeddings. The served search and the publish warm both start
// here. Nothing here logs a key, an endpoint's url, or a response body.
import { requireEnv } from "@oxagen/config/env";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import {
  SearchIndex,
  SearchIndexError,
  VectorCache,
  embeddingTarget,
  httpEmbedder,
  type Embedder,
  type EmbeddingTarget,
  type SearchIndexLog,
  type SearchIndexStore,
  type StoredVector,
} from "@oxagen/mcp-studio";
import { EMBEDDINGS_SETTING } from "@oxagen/oxagen/steering-repo/workspace";
import { decryptCredentialSecrets, resolveCredentialKms } from "@oxagen/plugins";
import { runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { and, eq, inArray, ne, notInArray, or } from "drizzle-orm";
import { logger } from "../logger";
import { searchUsageRecorder } from "./search-usage";

/** The workspace an index belongs to, with the principal its reads run as. */
export type SearchScope = TenantScope;

/** The most rows one statement reads or writes. */
const CHUNK = 256;

const CREDENTIAL_REF = /^oxagen:credential\/(.+)$/;

/** mcp.search_embeddings for one workspace, plus a sweep of rows no search reads. */
export interface SearchVectorStore extends SearchIndexStore {
  /**
   * Delete the workspace's rows that search no longer reads: every row under
   * another target key, and every row under keep whose hash is not in hashes.
   * A null keep deletes every row. Returns how many rows went.
   */
  sweep(keep: string | null, hashes?: readonly string[]): Promise<number>;
}

function inScope<T>(scope: SearchScope, run: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTenantScope(scope, () => withTenantDb(run));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The workspace's stored [embeddings] value, or undefined when it has none. */
export async function readEmbeddingSettings(scope: SearchScope): Promise<unknown> {
  const rows = await inScope(scope, (tx) =>
    tx
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, scope.workspaceId), eq(schema.workspaces.orgId, scope.orgId)))
      .limit(1),
  );
  const settings: unknown = rows[0]?.settings;
  return isRecord(settings) ? settings[EMBEDDINGS_SETTING] : undefined;
}

/** A vector as mcp.search_embeddings stores it: Float32 values in little endian order. */
export function encodeVector(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * 4);
  for (const [at, value] of vector.entries()) bytes.writeFloatLE(value, at * 4);
  return bytes;
}

/** A stored vector, or null when its bytes do not hold the dimensions its row gives. */
export function decodeVector(bytes: Buffer, dimensions: number): Float32Array | null {
  if (!Number.isInteger(dimensions) || dimensions < 1 || bytes.byteLength !== dimensions * 4) return null;
  const vector = new Float32Array(dimensions);
  for (let at = 0; at < dimensions; at += 1) vector[at] = bytes.readFloatLE(at * 4);
  return vector;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += CHUNK) out.push(items.slice(start, start + CHUNK));
  return out;
}

/** The workspace's vectors in mcp.search_embeddings. */
export function postgresSearchStore(scope: SearchScope): SearchVectorStore {
  const t = schema.mcpSearchEmbeddings;
  const workspace = and(eq(t.orgId, scope.orgId), eq(t.workspaceId, scope.workspaceId));
  return {
    async read(targetKey, hashes) {
      if (hashes.length === 0) return [];
      const found: StoredVector[] = [];
      await inScope(scope, async (tx) => {
        for (const part of chunks(hashes)) {
          const rows = await tx
            .select({ hash: t.contentHash, dimensions: t.dimensions, vector: t.vector })
            .from(t)
            .where(and(workspace, eq(t.targetKey, targetKey), inArray(t.contentHash, part)));
          for (const row of rows) {
            const vector = decodeVector(row.vector, row.dimensions);
            // A row whose bytes do not match its dimensions is left out, so
            // the entry is embedded again.
            if (vector !== null) found.push({ hash: row.hash, vector });
          }
        }
      });
      return found;
    },

    async write(targetKey, rows) {
      if (rows.length === 0) return;
      await inScope(scope, async (tx) => {
        for (const part of chunks(rows)) {
          await tx
            .insert(t)
            .values(
              part.map((row) => ({
                orgId: scope.orgId,
                workspaceId: scope.workspaceId,
                targetKey,
                contentHash: row.hash,
                dimensions: row.vector.length,
                vector: encodeVector(row.vector),
              })),
            )
            .onConflictDoNothing({ target: [t.workspaceId, t.targetKey, t.contentHash] });
        }
      });
    },

    async sweep(keep, hashes) {
      const stale =
        keep === null
          ? workspace
          : and(
              workspace,
              hashes === undefined ? ne(t.targetKey, keep) : or(ne(t.targetKey, keep), notInArray(t.contentHash, [...hashes])),
            );
      const deleted = await inScope(scope, (tx) => tx.delete(t).where(stale).returning({ id: t.id }));
      return deleted.length;
    },
  };
}

/** Oxagen's Voyage AI key, or null when the deployment has none. */
function voyageKey(): string | null {
  // An empty value fails the schema's min(1) inside requireEnv, and an unset
  // one passes as undefined. Both read as no key. The parse error can quote
  // the value, so it is dropped.
  try {
    return requireEnv(["VOYAGE_API_KEY"] as const).VOYAGE_API_KEY ?? null;
  } catch {
    return null;
  }
}

/** The secret an oxagen:credential/<name> reference names, or null when it cannot be read. */
async function credentialSecret(scope: SearchScope, reference: string): Promise<string | null> {
  const name = CREDENTIAL_REF.exec(reference)?.[1];
  if (name === undefined) return null;
  const c = schema.mcpCredentials;
  const [row] = await inScope(scope, (tx) =>
    tx
      .select({
        status: c.status,
        tokenKmsKeyId: c.tokenKmsKeyId,
        accessTokenEnc: c.accessTokenEnc,
        refreshTokenEnc: c.refreshTokenEnc,
        secretEnc: c.secretEnc,
        oauthClientSecretEnc: c.oauthClientSecretEnc,
      })
      .from(c)
      .where(and(eq(c.orgId, scope.orgId), eq(c.workspaceId, scope.workspaceId), eq(c.name, name)))
      .limit(1),
  );
  if (row === undefined || row.status !== "active") return null;
  const kms = resolveCredentialKms();
  if (kms === null) return null;
  try {
    const secrets = await decryptCredentialSecrets(row, kms);
    return secrets.accessToken ?? secrets.secret;
  } catch {
    // A ciphertext that does not decrypt reads as no key. The error can
    // carry key material, so it is dropped here.
    return null;
  }
}

/**
 * The embedder a target names, or null for keyword. Throws a
 * SearchIndexError with code no_key when the provider needs a key that is
 * not there.
 */
export async function embedderFor(target: EmbeddingTarget, scope: SearchScope): Promise<Embedder | null> {
  switch (target.provider) {
    case "keyword":
      return null;
    case "oxagen": {
      const apiKey = voyageKey();
      if (apiKey === null) {
        throw new SearchIndexError(
          "no_key",
          "VOYAGE_API_KEY is not set, so search ranks by keyword. Set it in this deployment's environment.",
        );
      }
      // Oxagen pays for these tokens, so each request writes a token_usage
      // row with no charge. A custom provider's own account pays for its tokens.
      return httpEmbedder({
        url: target.url,
        model: target.model,
        key: target.key,
        apiKey,
        inputType: true,
        onUsage: searchUsageRecorder(scope, target.model),
      });
    }
    case "custom": {
      let apiKey: string | null = null;
      if (target.credential !== null) {
        apiKey = await credentialSecret(scope, target.credential);
        if (apiKey === null) {
          throw new SearchIndexError(
            "no_key",
            "The credential [embeddings] credential names is missing, revoked, or unreadable, so search ranks by keyword. Connect it again, then publish.",
          );
        }
      }
      return httpEmbedder({ url: target.url, model: target.model, key: target.key, apiKey, inputType: false });
    }
  }
}

/** One cache for every index in this process, keyed by workspace and target. */
const cache = new VectorCache();

/**
 * The vectors every index in this process is embedding now, keyed like the
 * cache. Publish's warm and a served search build separate indexes, so this
 * map is what makes the second one wait for the first one's batch.
 */
const pending = new Map<string, Promise<Float32Array>>();

/** Warnings from the index. Its fields carry an error's name and counts, never a key or a url. */
export const searchIndexLog: SearchIndexLog = (message, fields) => {
  logger.warn(fields, message);
};

/** A workspace's index over an embedder, sharing the process's vector cache and pending vectors. */
export function searchIndexOf(embedder: Embedder, scope: SearchScope, store: SearchIndexStore = postgresSearchStore(scope)): SearchIndex {
  return new SearchIndex({ embedder, store, cache, pending, namespace: scope.workspaceId, log: searchIndexLog });
}

/**
 * The index a workspace's [embeddings] setting names, or null when it ranks
 * by keyword. Throws when the setting names a provider whose key is missing,
 * and the caller ranks by keyword.
 */
export async function searchIndexFor(scope: SearchScope): Promise<SearchIndex | null> {
  const target = embeddingTarget(await readEmbeddingSettings(scope));
  const embedder = await embedderFor(target, scope);
  return embedder === null ? null : searchIndexOf(embedder, scope);
}
