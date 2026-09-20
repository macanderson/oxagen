// evidence-store.ts — where frame bodies, archive segments and export bundles
// live (Mission Control spec §8.2, §13.3, §13.4; ADR-058).
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
// The plaintext inside a body's envelope is framed as
// `[u16be length][content type, UTF-8][bytes]`: the content type travels with
// the bytes it describes, authenticated under the same GCM tag, and no row in
// either store has to carry it. The recorded digest is over the bytes alone.
//
// The object key names the KEK too, so a body written after the crypto
// provider flips (@oxagen/crypto's env->kms lazy migration) lands beside the
// earlier one instead of over it, and every older reference still resolves to
// an envelope its own key id can open. The same plaintext under the same
// tenant and KEK lands on the same key, so a retried append rewrites an
// equivalent object rather than minting a second one.
//
// The module lives in @oxagen/run-ledger so the ingest handlers, the read
// handlers and the durable jobs (@oxagen/inngest-functions) share one store.
import {
  createIngestionCryptoAdapter,
  decrypt,
  encrypt,
  resolveIngestionCryptoAdapterForKeyId,
  type IngestionCryptoAdapter,
} from "@oxagen/crypto";
import {
  ARCHIVE_SEGMENT_CONTENT_TYPE,
  SHA256_DIGEST_PATTERN,
} from "@oxagen/tacho";
import { storage, type StorageAdapter } from "@oxagen/storage";
import { MESSAGE_ASSEMBLY_CONTENT_TYPE } from "./content-blocks";
import type { RunArchiveStore, RunBodyStore } from "./frame-body";

/** `evb:v1:<key id>:<sha256 hex>`: the body reference a frame row carries. */
const BODY_REF = /^evb:v1:(.+):([0-9a-f]{64})$/;

const BODY_OBJECT_CONTENT_TYPE = "application/octet-stream";
const BUNDLE_CONTENT_TYPE = "application/zip";

/** The longest content type the body frame carries (RFC 6838 names are short). */
const MAX_CONTENT_TYPE_BYTES = 255;

interface EvidenceScope {
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

/**
 * The key id as a path segment. @oxagen/crypto mints ids of the form
 * `ingestion:<provider>:v<n>` and refuses any other on the read path, so
 * mapping the colons keeps the segment safe for every storage driver without
 * two live ids sharing one.
 */
function keyIdSegment(keyId: string): string {
  return keyId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function evidenceBodyKey(
  scope: EvidenceScope,
  keyId: string,
  digestHex: string,
): string {
  return `evidence/${scope.orgId}/${scope.workspaceId}/bodies/${keyIdSegment(keyId)}/${digestHex}`;
}

/**
 * Where a frame's REASSEMBLY lands: the message a recorded model stream folded
 * into, derived at ingest and stored beside the wire (`content-blocks.ts`).
 *
 * Keyed by the body's own digest under the same key id, so a reader that holds
 * the frame's body reference finds the assembly without a second column and
 * without a second round trip to Postgres. It is derived, never evidence: the
 * chain covers the body bytes and nothing here, and an assembly that is
 * missing, stale or unreadable costs a reader nothing but a fold on the spot.
 */
export function evidenceAssemblyKey(
  scope: EvidenceScope,
  keyId: string,
  digestHex: string,
): string {
  return `evidence/${scope.orgId}/${scope.workspaceId}/assemblies/${keyIdSegment(keyId)}/${digestHex}`;
}

function evidenceSegmentKey(
  scope: EvidenceScope,
  attemptId: string,
  digestHex: string,
): string {
  return `evidence/${scope.orgId}/${scope.workspaceId}/segments/${attemptId}/${digestHex}.ndjson.zst`;
}

function evidenceBundleKey(
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

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** `[u16be length][content type][bytes]`. */
function frameBodyPlaintext(contentType: string, bytes: Uint8Array): Buffer {
  const type = encoder.encode(contentType);
  if (type.length === 0 || type.length > MAX_CONTENT_TYPE_BYTES) {
    throw new RangeError(`content type length out of range: ${type.length}`);
  }
  const header = Buffer.alloc(2);
  header.writeUInt16BE(type.length, 0);
  return Buffer.concat([header, type, bytes]);
}

export function parseFrameBodyPlaintext(plaintext: Uint8Array): {
  contentType: string;
  bytes: Uint8Array;
} {
  const buf = Buffer.from(plaintext);
  if (buf.length < 2) throw new RangeError("frame body plaintext too short");
  const length = buf.readUInt16BE(0);
  if (length === 0 || 2 + length > buf.length) {
    throw new RangeError("frame body content type length out of range");
  }
  return {
    contentType: decoder.decode(buf.subarray(2, 2 + length)),
    bytes: new Uint8Array(buf.subarray(2 + length)),
  };
}

interface EvidenceStoreDeps {
  storage: StorageAdapter;
  /** The KEK new objects are wrapped under. */
  writeCrypto: () => IngestionCryptoAdapter;
  /** The KEK a stored reference names. */
  readCrypto: (keyId: string) => IngestionCryptoAdapter;
}

interface StoredFrameBody {
  /** The redacted plaintext the reference names; the digest proves it. */
  bytes: Uint8Array;
  contentType: string;
  digestHex: string;
}

export interface EvidenceStore extends RunBodyStore, RunArchiveStore {
  getBody(scope: EvidenceScope, ref: string): Promise<StoredFrameBody>;
  /** Required here: this store always has somewhere to put a fold. */
  putAssembly(input: {
    orgId: string;
    workspaceId: string;
    runId: string;
    bodyRef: string;
    bytes: Uint8Array;
  }): Promise<void>;
  /**
   * The reassembly stored beside the body `ref` names, or null when none was
   * written, it was written by an older fold, or it cannot be read. A null is
   * never an error: the caller folds the wire itself and carries on.
   */
  getAssembly(scope: EvidenceScope, ref: string): Promise<Uint8Array | null>;
  /** The archive segment bytes a seal's reference names. */
  getSegment(ref: string): Promise<Uint8Array>;
  /** Write an export bundle once; returns where it landed. */
  putBundle(input: {
    scope: EvidenceScope;
    exportId: string;
    digest: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
}

export function createEvidenceStore(deps: EvidenceStoreDeps): EvidenceStore {
  return {
    async put(input) {
      const { adapter, keyId } = deps.writeCrypto();
      const digestHex = digestHexOf(input.digest);
      const ciphertext = await encrypt(
        frameBodyPlaintext(input.contentType, input.bytes),
        keyId,
        { adapter },
      );
      const key = evidenceBodyKey(input, keyId, digestHex);
      const written = await deps.storage.put({
        key,
        body: ciphertext,
        contentType: BODY_OBJECT_CONTENT_TYPE,
        access: "private",
      });
      if (written.key !== key) {
        throw new Error(
          `evidence body landed on an unexpected key: ${written.key}`,
        );
      }
      return { ref: evidenceBodyRef(keyId, digestHex) };
    },

    async getBody(scope, ref) {
      const parsed = parseEvidenceBodyRef(ref);
      if (!parsed)
        throw new TypeError(`not an evidence body reference: ${ref}`);
      const { adapter } = deps.readCrypto(parsed.keyId);
      const object = await deps.storage.get(
        evidenceBodyKey(scope, parsed.keyId, parsed.digestHex),
      );
      const ciphertext = await readAll(object.body);
      const plaintext = await decrypt(Buffer.from(ciphertext), parsed.keyId, {
        adapter,
      });
      const { contentType, bytes } = parseFrameBodyPlaintext(plaintext);
      return { bytes, contentType, digestHex: parsed.digestHex };
    },

    async putAssembly(input) {
      const parsed = parseEvidenceBodyRef(input.bodyRef);
      if (!parsed) {
        throw new TypeError(
          `not an evidence body reference: ${input.bodyRef}`,
        );
      }
      const { adapter } = deps.readCrypto(parsed.keyId);
      const ciphertext = await encrypt(
        frameBodyPlaintext(MESSAGE_ASSEMBLY_CONTENT_TYPE, input.bytes),
        parsed.keyId,
        { adapter },
      );
      await deps.storage.put({
        key: evidenceAssemblyKey(input, parsed.keyId, parsed.digestHex),
        body: ciphertext,
        contentType: BODY_OBJECT_CONTENT_TYPE,
        access: "private",
      });
    },

    async getAssembly(scope, ref) {
      const parsed = parseEvidenceBodyRef(ref);
      if (!parsed) return null;
      try {
        const { adapter } = deps.readCrypto(parsed.keyId);
        const object = await deps.storage.get(
          evidenceAssemblyKey(scope, parsed.keyId, parsed.digestHex),
        );
        const plaintext = await decrypt(
          Buffer.from(await readAll(object.body)),
          parsed.keyId,
          { adapter },
        );
        return parseFrameBodyPlaintext(plaintext).bytes;
      } catch {
        // Derived, not evidence: a miss is a fold the caller does itself.
        return null;
      }
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

    async getSegment(ref) {
      const object = await deps.storage.get(ref);
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
        contentType: BUNDLE_CONTENT_TYPE,
        access: "private",
      });
      return { ref: key };
    },
  };
}

let defaultStore: EvidenceStore | null = null;

/** The process-wide store on the configured storage driver and KEK. */
export function evidenceStore(): EvidenceStore {
  if (defaultStore) return defaultStore;
  defaultStore = createEvidenceStore({
    storage: storage(),
    writeCrypto: createIngestionCryptoAdapter,
    readCrypto: resolveIngestionCryptoAdapterForKeyId,
  });
  return defaultStore;
}

/**
 * The archive seam over the process-wide store, resolved at each call.
 * `evidenceStore()` opens the storage driver from the environment, so a
 * module that constructs a run store at load time hands the ledger this and
 * pays for the driver only when a compacted attempt is read or a seal is
 * written.
 */
export const deferredEvidenceArchive: RunArchiveStore = {
  getSegment: (ref) => evidenceStore().getSegment(ref),
  putSegment: (input) => evidenceStore().putSegment(input),
};

/**
 * The frame-body seam over the same store, resolved at each call for the same
 * reason.
 *
 * A run store that has none refuses any append whose frame carries a body its
 * pinned policy retains (`resolveBodyColumns`), and the default assistant
 * policy retains every content class. So a producer that starts passing
 * bodies must be constructed with this, or every turn it records fails at the
 * first frame.
 */
export const deferredEvidenceBodies: RunBodyStore = {
  put: (input) => evidenceStore().put(input),
  putAssembly: (input) => evidenceStore().putAssembly(input),
};
