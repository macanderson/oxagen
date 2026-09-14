// evidence-bodies.ts — where frame bodies, archive segments and export
// bundles live (Mission Control spec §8.2, §13.3, §13.4; ADR-057).
//
// Every object is written through @oxagen/storage under a key that names the
// organisation and workspace first, so the tenant is the path and a
// cross-tenant reference cannot resolve to a key inside another tenant's
// prefix. Bodies are content-addressed by the sha256 of their redacted
// plaintext; the object holds an @oxagen/crypto envelope (a fresh data key per
// object, wrapped by the platform KEK the KmsAdapter seam names), and the
// reference carries the key id so a later KEK — a per-organisation one, ADR-042
// — decrypts by routing on the reference alone. Segments and bundles are keyed
// by the digest of the bytes as stored.
//
// The same plaintext under the same tenant lands on the same key, so a retried
// append rewrites an equivalent object rather than minting a second one.
import {
  createIngestionCryptoAdapter,
  decrypt,
  encrypt,
  resolveIngestionCryptoAdapterForKeyId,
  type IngestionCryptoAdapter,
} from "@oxagen/crypto";
import type { RunArchiveStore, RunBodyStore } from "@oxagen/run-ledger";
import {
  ARCHIVE_SEGMENT_CONTENT_TYPE,
  SHA256_DIGEST_PATTERN,
} from "@oxagen/tacho";
import { storage, type StorageAdapter } from "@oxagen/storage";

/** `evb:v1:<key id>:<sha256 hex>`: the body reference a frame row carries. */
const BODY_REF = /^evb:v1:(.+):([0-9a-f]{64})$/;

export const BODY_OBJECT_CONTENT_TYPE = "application/octet-stream";

export interface EvidenceScope {
  orgId: string;
  workspaceId: string;
}

export function evidenceBodyRef(keyId: string, digestHex: string): string {
  return `evb:v1:${keyId}:${digestHex}`;
}

/** The key id and digest a body reference names, or null for a foreign ref. */
export function parseEvidenceBodyRef(
  ref: string,
): { keyId: string; digestHex: string } | null {
  const match = BODY_REF.exec(ref);
  if (!match) return null;
  return { keyId: match[1] as string, digestHex: match[2] as string };
}

export function evidenceBodyKey(
  scope: EvidenceScope,
  digestHex: string,
): string {
  return `evidence/${scope.orgId}/${scope.workspaceId}/bodies/${digestHex}`;
}

export function evidenceSegmentKey(
  scope: EvidenceScope,
  attemptId: string,
  digestHex: string,
): string {
  return `evidence/${scope.orgId}/${scope.workspaceId}/segments/${attemptId}/${digestHex}.ndjson.zst`;
}

export function evidenceBundleKey(
  scope: EvidenceScope,
  exportId: string,
  digestHex: string,
): string {
  return `evidence/${scope.orgId}/${scope.workspaceId}/exports/${exportId}/${digestHex}.zip`;
}

function digestHexOf(digest: string): string {
  if (!SHA256_DIGEST_PATTERN.test(digest)) {
    throw new TypeError(`not a sha256 digest: ${digest}`);
  }
  return digest.slice("sha256:".length);
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface EvidenceBodyStoreDeps {
  storage: StorageAdapter;
  /** The KEK new objects are wrapped under. */
  writeCrypto: () => IngestionCryptoAdapter;
  /** The KEK a stored reference names. */
  readCrypto: (keyId: string) => IngestionCryptoAdapter;
}

export interface EvidenceBodyStore extends RunBodyStore, RunArchiveStore {
  /** The redacted plaintext a reference names; the digest proves it. */
  getBody(
    scope: EvidenceScope,
    ref: string,
  ): Promise<{ bytes: Uint8Array; digestHex: string }>;
  /** The archive segment bytes a seal's reference names. */
  getSegment(key: string): Promise<Uint8Array>;
  /** Write an export bundle once; returns where it landed. */
  putBundle(input: {
    scope: EvidenceScope;
    exportId: string;
    digest: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
}

export function createEvidenceBodyStore(
  deps: EvidenceBodyStoreDeps,
): EvidenceBodyStore {
  return {
    async put(input) {
      const { adapter, keyId } = deps.writeCrypto();
      const digestHex = digestHexOf(input.digest);
      const ciphertext = await encrypt(Buffer.from(input.bytes), keyId, {
        adapter,
      });
      const { key } = await deps.storage.put({
        key: evidenceBodyKey(input, digestHex),
        body: ciphertext,
        contentType: BODY_OBJECT_CONTENT_TYPE,
        access: "private",
      });
      if (key !== evidenceBodyKey(input, digestHex)) {
        throw new Error(`evidence body landed on an unexpected key: ${key}`);
      }
      return { ref: evidenceBodyRef(keyId, digestHex) };
    },

    async getBody(scope, ref) {
      const parsed = parseEvidenceBodyRef(ref);
      if (!parsed)
        throw new TypeError(`not an evidence body reference: ${ref}`);
      const { adapter } = deps.readCrypto(parsed.keyId);
      const object = await deps.storage.get(
        evidenceBodyKey(scope, parsed.digestHex),
      );
      const ciphertext = await readAll(object.body);
      const bytes = await decrypt(Buffer.from(ciphertext), parsed.keyId, {
        adapter,
      });
      return { bytes: new Uint8Array(bytes), digestHex: parsed.digestHex };
    },

    async putSegment(input) {
      const { key } = await deps.storage.put({
        key: evidenceSegmentKey(
          input,
          input.attemptId,
          digestHexOf(input.digest),
        ),
        body: input.bytes,
        contentType: ARCHIVE_SEGMENT_CONTENT_TYPE,
        access: "private",
      });
      return { ref: key };
    },

    async getSegment(key) {
      const object = await deps.storage.get(key);
      return readAll(object.body);
    },

    async putBundle(input) {
      const { key } = await deps.storage.put({
        key: evidenceBundleKey(
          input.scope,
          input.exportId,
          digestHexOf(input.digest),
        ),
        body: input.bytes,
        contentType: "application/zip",
        access: "private",
      });
      return { ref: key };
    },
  };
}

let defaultStore: EvidenceBodyStore | null = null;

/** The process-wide store on the configured storage driver and KEK. */
export function evidenceBodyStore(): EvidenceBodyStore {
  if (defaultStore) return defaultStore;
  defaultStore = createEvidenceBodyStore({
    storage: storage(),
    writeCrypto: createIngestionCryptoAdapter,
    readCrypto: resolveIngestionCryptoAdapterForKeyId,
  });
  return defaultStore;
}
