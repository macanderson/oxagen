// Scratch objects for the run-enrichment job (#3784): the transcript chunks
// and manifest one step writes and a later step reads. They live under
// scratch/run-enrich/<job run id>/<name>, never under the content-addressed
// bodies/ prefix, so deleting them can never remove a frame body.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import { createFsAdapter, type StorageAdapter } from "@oxagen/storage";
import { createEvidenceStore, evidenceScratchKey } from "./evidence-store";

const root = mkdtempSync(join(tmpdir(), "evidence-scratch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const scope = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const JOB = "01K5RQ8M4Z3V9X2W7T6Y5U4I3O";
const kms = createLocalKmsAdapter(randomBytes(32));
const crypto = { adapter: kms, keyId: "ingestion:env:v1" };
const fs = createFsAdapter(root);
const enc = new TextEncoder();
const dec = new TextDecoder();

function storeOn(storage: StorageAdapter = fs) {
  return createEvidenceStore({
    storage,
    writeCrypto: () => crypto,
    readCrypto: (keyId) => {
      if (keyId !== crypto.keyId) throw new Error(`unknown key ${keyId}`);
      return crypto;
    },
  });
}

async function readRaw(key: string): Promise<Buffer> {
  const object = await fs.get(key);
  const chunks: Uint8Array[] = [];
  const reader = object.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("evidence scratch objects", () => {
  it("keys an object by tenant, job and name, under scratch/run-enrich and never bodies/", () => {
    const key = evidenceScratchKey(scope, JOB, "chunk-0");
    expect(key).toBe(
      `evidence/${scope.orgId}/${scope.workspaceId}/scratch/run-enrich/${JOB}/chunk-0`,
    );
    expect(key).not.toContain("/bodies/");
  });

  it("writes an encrypted object and reads the plaintext and content type back", async () => {
    const store = storeOn();
    await store.putScratch({
      scope,
      jobRunId: JOB,
      name: "chunk-0",
      contentType: "text/plain",
      bytes: enc.encode("Please repair authentication."),
    });

    // The object at rest is not the plaintext.
    const raw = await readRaw(evidenceScratchKey(scope, JOB, "chunk-0"));
    expect(raw.includes(Buffer.from("repair authentication"))).toBe(false);

    const back = await store.getScratch(scope, JOB, "chunk-0");
    expect(dec.decode(back.bytes)).toBe("Please repair authentication.");
    expect(back.contentType).toBe("text/plain");
    // Nothing landed under the content-addressed prefix.
    const bodies = join(
      root,
      "evidence",
      scope.orgId,
      scope.workspaceId,
      "bodies",
    );
    expect(() => readdirSync(bodies)).toThrow();
  });

  it("replaces an object when a step writes the same name again", async () => {
    const store = storeOn();
    const write = (text: string) =>
      store.putScratch({
        scope,
        jobRunId: JOB,
        name: "manifest",
        contentType: "application/json",
        bytes: enc.encode(text),
      });
    await write('["chunk-0"]');
    await write('["chunk-0","chunk-1"]');
    const back = await store.getScratch(scope, JOB, "manifest");
    expect(dec.decode(back.bytes)).toBe('["chunk-0","chunk-1"]');
  });

  it("reads an object written under an earlier KEK after the write key changes", async () => {
    const a = crypto;
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
    const put = (name: string) =>
      migrating.putScratch({
        scope,
        jobRunId: JOB,
        name,
        contentType: "text/plain",
        bytes: enc.encode(name),
      });
    await put("before-flip");
    write = b;
    await put("after-flip");
    for (const name of ["before-flip", "after-flip"]) {
      const back = await migrating.getScratch(scope, JOB, name);
      expect(dec.decode(back.bytes)).toBe(name);
    }
  });

  it("deletes the named objects, and a second delete or a name never written is a no-op", async () => {
    const store = storeOn();
    for (const name of ["chunk-0", "chunk-1", "manifest"]) {
      await store.putScratch({
        scope,
        jobRunId: JOB,
        name,
        contentType: "text/plain",
        bytes: enc.encode(name),
      });
    }
    const names = ["chunk-0", "chunk-1", "chunk-2", "manifest"];
    await store.deleteScratch(scope, JOB, names);
    await store.deleteScratch(scope, JOB, names);
    for (const name of names) {
      await expect(store.getScratch(scope, JOB, name)).rejects.toThrow();
    }
  });

  it("keeps each job's objects apart, so one job's cleanup leaves another's (negative)", async () => {
    const store = storeOn();
    const other = "01K5RQ8M4Z3V9X2W7T6Y5U4I3P";
    for (const jobRunId of [JOB, other]) {
      await store.putScratch({
        scope,
        jobRunId,
        name: "chunk-0",
        contentType: "text/plain",
        bytes: enc.encode(jobRunId),
      });
    }
    await store.deleteScratch(scope, JOB, ["chunk-0"]);
    const kept = await store.getScratch(scope, other, "chunk-0");
    expect(dec.decode(kept.bytes)).toBe(other);
  });

  it("refuses a job id or name that is not one path segment, and deletes nothing (negative)", async () => {
    const del = vi.fn((key: string) => fs.delete(key));
    const store = storeOn({ ...fs, delete: del });
    const refused = ["", "..", ".hidden", "a/b", "../bodies", "x".repeat(129)];
    for (const name of refused) {
      expect(() => evidenceScratchKey(scope, JOB, name)).toThrow(TypeError);
    }
    expect(() => evidenceScratchKey(scope, "../other", "chunk-0")).toThrow(
      TypeError,
    );
    await expect(
      store.putScratch({
        scope,
        jobRunId: JOB,
        name: "../escape",
        contentType: "text/plain",
        bytes: enc.encode("x"),
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.deleteScratch(scope, JOB, ["chunk-0", "../escape"]),
    ).rejects.toThrow(TypeError);
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses an object whose key id frame is broken (negative)", async () => {
    const store = storeOn();
    const key = (name: string) => evidenceScratchKey(scope, JOB, name);
    await fs.put({ key: key("short"), body: new Uint8Array([0]) });
    await fs.put({ key: key("overlong"), body: new Uint8Array([0, 9, 1]) });
    await fs.put({ key: key("empty-id"), body: new Uint8Array([0, 0, 1]) });
    await expect(store.getScratch(scope, JOB, "short")).rejects.toThrow(
      /too short/,
    );
    await expect(store.getScratch(scope, JOB, "overlong")).rejects.toThrow(
      /out of range/,
    );
    await expect(store.getScratch(scope, JOB, "empty-id")).rejects.toThrow(
      /out of range/,
    );
  });

  it("refuses a KEK id it cannot frame, and a write the driver put elsewhere (negative)", async () => {
    const noKeyId = createEvidenceStore({
      storage: fs,
      writeCrypto: () => ({ adapter: kms, keyId: "" }),
      readCrypto: () => crypto,
    });
    const input = {
      scope,
      jobRunId: JOB,
      name: "chunk-0",
      contentType: "text/plain",
      bytes: enc.encode("x"),
    };
    await expect(noKeyId.putScratch(input)).rejects.toThrow(RangeError);

    const moved = storeOn({
      ...fs,
      put: async (object) => ({
        ...(await fs.put(object)),
        key: `${object.key}-suffix`,
      }),
    });
    await expect(moved.putScratch(input)).rejects.toThrow(/unexpected key/);
  });
});
