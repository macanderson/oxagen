import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import { createFsAdapter, type StorageAdapter } from "@oxagen/storage";
import { digestBytes } from "@oxagen/tacho";
import {
  BodyKeyGoneError,
  createEvidenceStore,
  evidenceAssemblyKey,
  evidenceBodyKey,
  evidenceBodyRef,
  parseEvidenceBodyRef,
  parseFrameBodyPlaintext,
} from "./evidence-store";

const root = mkdtempSync(join(tmpdir(), "evidence-bodies-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const scope = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const runId = "33333333-3333-4333-8333-333333333333";
const kms = createLocalKmsAdapter(randomBytes(32));
const crypto = { adapter: kms, keyId: "evidence:test:v1" };
const fs = createFsAdapter(root);
const store = createEvidenceStore({
  storage: fs,
  writeCrypto: () => crypto,
  readCrypto: (keyId) => {
    if (keyId !== crypto.keyId) throw new Error(`unknown key ${keyId}`);
    return crypto;
  },
});
const enc = new TextEncoder();

describe("evidence body store", () => {
  it("writes an encrypted, content-addressed object and reads the plaintext back", async () => {
    const bytes = enc.encode('{"prompt":"deploy"}');
    const digest = digestBytes(bytes);
    const { ref } = await store.put({
      ...scope,
      runId,
      digest,
      contentType: "application/json",
      bytes,
    });
    expect(ref).toBe(evidenceBodyRef(crypto.keyId, digest.slice(7)));

    // The object at rest is not the plaintext.
    const stored = await fs.get(
      evidenceBodyKey(scope, crypto.keyId, digest.slice(7)),
    );
    const chunks: Uint8Array[] = [];
    const reader = stored.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(Buffer.concat(chunks).includes(Buffer.from(bytes))).toBe(false);

    const back = await store.getBody(scope, ref);
    expect(new TextDecoder().decode(back.bytes)).toBe('{"prompt":"deploy"}');
    expect(back.contentType).toBe("application/json");
    expect(digestBytes(back.bytes)).toBe(digest);
  });

  it("frames the content type with the bytes and refuses a frame it cannot read", () => {
    expect(() => parseFrameBodyPlaintext(new Uint8Array([0]))).toThrow(
      /too short/,
    );
    expect(() => parseFrameBodyPlaintext(new Uint8Array([0, 9, 1]))).toThrow(
      /out of range/,
    );
    expect(evidenceBodyKey(scope, "ingestion:env:v1", "0".repeat(64))).toBe(
      `evidence/${scope.orgId}/${scope.workspaceId}/bodies/ingestion_env_v1/${"0".repeat(64)}`,
    );
  });

  it("keeps a body written under an earlier KEK readable after the write key changes", async () => {
    const a = { adapter: kms, keyId: "ingestion:env:v1" };
    const b = {
      adapter: createLocalKmsAdapter(randomBytes(32)),
      keyId: "ingestion:kms:v1",
    };
    const keys = new Map([
      [a.keyId, a],
      [b.keyId, b],
    ]);
    let write = a;
    const migrating = createEvidenceStore({
      storage: fs,
      writeCrypto: () => write,
      readCrypto: (keyId) => {
        const found = keys.get(keyId);
        if (!found) throw new Error(`unknown key ${keyId}`);
        return found;
      },
    });
    const bytes = enc.encode("same bytes, two providers");
    const digest = digestBytes(bytes);
    const body = { ...scope, runId, digest, contentType: "text/plain", bytes };

    const first = await migrating.put(body);
    write = b;
    const second = await migrating.put(body);
    expect(first.ref).toBe(evidenceBodyRef(a.keyId, digest.slice(7)));
    expect(second.ref).toBe(evidenceBodyRef(b.keyId, digest.slice(7)));

    for (const ref of [first.ref, second.ref]) {
      const back = await migrating.getBody(scope, ref);
      expect(new TextDecoder().decode(back.bytes)).toBe(
        "same bytes, two providers",
      );
    }
  });

  it("keys a body by its tenant, so another tenant's reference does not resolve", async () => {
    const bytes = enc.encode("mine");
    const digest = digestBytes(bytes);
    const { ref } = await store.put({
      ...scope,
      runId,
      digest,
      contentType: "text/plain",
      bytes,
    });
    await expect(
      store.getBody(
        { ...scope, orgId: "44444444-4444-4444-8444-444444444444" },
        ref,
      ),
    ).rejects.toThrow();
  });

  // Finding P3-1 of the ADR-182 fourth review: erasure destroys the key and
  // leaves the object, so a reader must see a lasting failure, not a
  // missing object and not a failure that may pass.
  it("says a body's key is gone when the object is there and its key no longer opens it", async () => {
    const bytes = enc.encode("erased words");
    const digest = digestBytes(bytes);
    const { ref } = await store.put({
      ...scope,
      runId,
      digest,
      contentType: "text/plain",
      bytes,
    });
    const shredded = createEvidenceStore({
      storage: fs,
      writeCrypto: () => crypto,
      readCrypto: () => ({
        adapter: createLocalKmsAdapter(randomBytes(32)),
        keyId: crypto.keyId,
      }),
    });
    const failure = await shredded.getBody(scope, ref).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(BodyKeyGoneError);
    expect(failure).toMatchObject({ keyId: crypto.keyId });
  });

  it("passes on a failure that may pass as it came (negative)", async () => {
    const bytes = enc.encode("throttled words");
    const digest = digestBytes(bytes);
    const { ref } = await store.put({
      ...scope,
      runId,
      digest,
      contentType: "text/plain",
      bytes,
    });
    const throttle = new Error("Rate exceeded");
    throttle.name = "ThrottlingException";
    const throttled = createEvidenceStore({
      storage: fs,
      writeCrypto: () => crypto,
      readCrypto: () => ({
        adapter: {
          generateDataKey: () => Promise.reject(throttle),
          decryptDataKey: () => Promise.reject(throttle),
        },
        keyId: crypto.keyId,
      }),
    });
    await expect(throttled.getBody(scope, ref)).rejects.toBe(throttle);
  });

  it("refuses a digest that is not sha256 and a reference it did not mint", async () => {
    await expect(
      store.put({
        ...scope,
        runId,
        digest: "md5:abc",
        contentType: "text/plain",
        bytes: enc.encode("x"),
      }),
    ).rejects.toThrow(/not a sha256 digest/);
    await expect(store.getBody(scope, "evb:v0:x")).rejects.toThrow(
      /not an evidence body reference/,
    );
    expect(parseEvidenceBodyRef("evb:v1:a:b:" + "0".repeat(64))).toEqual({
      keyId: "a:b",
      digestHex: "0".repeat(64),
    });
  });

  it("writes a segment and a bundle by the digest of their bytes", async () => {
    const bytes = enc.encode("segment");
    const digest = digestBytes(bytes);
    const attemptId = "55555555-5555-4555-8555-555555555555";
    const { ref } = await store.putSegment({
      ...scope,
      runId,
      attemptId,
      digest,
      bytes,
    });
    expect(ref).toBe(
      `evidence/${scope.orgId}/${scope.workspaceId}/segments/${attemptId}/${digest.slice(7)}.ndjson.zst`,
    );
    expect(new TextDecoder().decode(await store.getSegment(ref))).toBe(
      "segment",
    );

    const bundle = await store.putBundle({
      scope,
      exportId: "rexp_1",
      digest,
      bytes,
    });
    expect(bundle.ref).toBe(
      `evidence/${scope.orgId}/${scope.workspaceId}/exports/rexp_1/${digest.slice(7)}.zip`,
    );
  });
});

// #4202: keys are content-addressed, and tacho ingest wrote the same key
// again whenever a batch repeated a body. The store now writes a key once per
// process while it remembers the key.
describe("evidence store write memory", () => {
  function countingStore(rememberedWriteKeys?: number) {
    const put = vi.fn((input: Parameters<StorageAdapter["put"]>[0]) =>
      fs.put(input),
    );
    const counted: StorageAdapter = { ...fs, put };
    const counting = createEvidenceStore({
      storage: counted,
      writeCrypto: () => crypto,
      readCrypto: () => crypto,
      ...(rememberedWriteKeys === undefined ? {} : { rememberedWriteKeys }),
    });
    return { counting, put };
  }
  function body(text: string) {
    const bytes = enc.encode(text);
    return {
      ...scope,
      runId,
      digest: digestBytes(bytes),
      contentType: "text/plain",
      bytes,
    };
  }

  it("writes a body key once and answers the same reference after", async () => {
    const { counting, put } = countingStore();
    const input = body("written once");

    const first = await counting.put(input);
    const second = await counting.put(input);

    expect(put).toHaveBeenCalledTimes(1);
    expect(second.ref).toBe(first.ref);
    const back = await counting.getBody(scope, second.ref);
    expect(new TextDecoder().decode(back.bytes)).toBe("written once");
  });

  it("shares one write between concurrent puts of the same body", async () => {
    const { counting, put } = countingStore();
    const input = body("in flight twice");

    const [a, b] = await Promise.all([
      counting.put(input),
      counting.put(input),
    ]);

    expect(put).toHaveBeenCalledTimes(1);
    expect(a.ref).toBe(b.ref);
  });

  it("writes an assembly key once", async () => {
    const { counting, put } = countingStore();
    const input = body("stream wire");
    const { ref } = await counting.put(input);
    const assembly = {
      ...scope,
      runId,
      bodyRef: ref,
      bytes: enc.encode('{"blocks":[]}'),
    };

    await counting.putAssembly(assembly);
    await counting.putAssembly(assembly);

    const keys = put.mock.calls.map((call) => call[0].key);
    const digestHex = input.digest.slice(7);
    expect(keys).toEqual([
      evidenceBodyKey(scope, crypto.keyId, digestHex),
      evidenceAssemblyKey(scope, crypto.keyId, digestHex),
    ]);
    expect(await counting.getAssembly(scope, ref)).toEqual(
      enc.encode('{"blocks":[]}'),
    );
  });

  it("keeps each tenant's key apart, so one tenant's write does not skip another's", async () => {
    const { counting, put } = countingStore();
    const input = body("same bytes, two tenants");

    await counting.put(input);
    await counting.put({
      ...input,
      workspaceId: "66666666-6666-4666-8666-666666666666",
    });

    expect(put).toHaveBeenCalledTimes(2);
  });

  it("forgets a write that failed, so the next put writes the key", async () => {
    const { counting, put } = countingStore();
    const input = body("first attempt fails");
    put.mockRejectedValueOnce(new Error("store unavailable"));

    await expect(counting.put(input)).rejects.toThrow("store unavailable");
    await counting.put(input);

    expect(put).toHaveBeenCalledTimes(2);
    const back = await counting.getBody(
      scope,
      evidenceBodyRef(crypto.keyId, input.digest.slice(7)),
    );
    expect(new TextDecoder().decode(back.bytes)).toBe("first attempt fails");
  });

  it("remembers a bounded number of keys and writes an evicted key again", async () => {
    const { counting, put } = countingStore(2);
    const [a, b, c] = ["lru a", "lru b", "lru c"].map(body);

    await counting.put(a!);
    await counting.put(b!);
    await counting.put(a!); // a is now the most recent
    await counting.put(c!); // evicts b, the least recent
    expect(put).toHaveBeenCalledTimes(3);

    await counting.put(a!);
    expect(put).toHaveBeenCalledTimes(3);
    await counting.put(b!);
    expect(put).toHaveBeenCalledTimes(4);
  });
});
