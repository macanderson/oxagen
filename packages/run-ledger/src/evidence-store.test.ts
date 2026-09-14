import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import { createFsAdapter } from "@oxagen/storage";
import { digestBytes } from "@oxagen/tacho";
import {
  createEvidenceStore,
  evidenceBodyKey,
  evidenceBodyRef,
  evidenceKeyScope,
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
    const stored = await fs.get(evidenceBodyKey(scope, digest.slice(7)));
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
    expect(evidenceKeyScope(evidenceBodyKey(scope, "0".repeat(64)))).toEqual(
      scope,
    );
    expect(evidenceKeyScope("privacy-exports/x.zip")).toBeNull();
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
