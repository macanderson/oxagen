import { randomBytes } from "node:crypto";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import { StorageNotFoundError, type StorageAdapter } from "@oxagen/storage";
import { digestBytes } from "@oxagen/tacho";
import { describe, expect, it, vi } from "vitest";
import {
  createEvidenceStore,
  EvidenceBodyTooLargeError,
  EvidenceStoreBusyError,
  evidenceBodyRef,
  parseFrameBodyPlaintext,
} from "./evidence-store";

const crypto = {
  adapter: createLocalKmsAdapter(randomBytes(32)),
  keyId: "evidence:capacity:v1",
};
const scope = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
function body(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    ...scope,
    runId: "33333333-3333-4333-8333-333333333333",
    digest: digestBytes(bytes),
    contentType: "text/plain",
    bytes,
  };
}
function fixture(options: {
  rememberedWriteKeys?: number;
  maxActiveWrites?: number;
  maxActiveWriteBytes?: number;
} = {}) {
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn<StorageAdapter["put"]>(async (input) => {
    if (!(input.body instanceof Uint8Array)) throw new Error("Expected bytes");
    objects.set(input.key, input.body);
    return {
      key: input.key,
      url: input.key,
      access: input.access ?? "public",
      bytes: input.body.byteLength,
    };
  });
  const get = vi.fn<StorageAdapter["get"]>(async (key) => {
    const bytes = objects.get(key);
    if (!bytes) throw new StorageNotFoundError(key);
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      contentType: null,
      sizeBytes: bytes.byteLength,
    };
  });
  const storage: StorageAdapter = {
    driver: "memory",
    put,
    get,
    delete: async (key) => { objects.delete(key); },
  };
  const deps = {
    storage,
    writeCrypto: () => crypto,
    readCrypto: () => crypto,
    ...options,
  };
  return { store: createEvidenceStore(deps), deps, put, get, objects };
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe("evidence storage capacity", () => {
  it("keeps an active write through completed-key eviction and shares it across stores", async () => {
    const { store, deps, put } = fixture({ rememberedWriteKeys: 1 });
    const second = createEvidenceStore(deps);
    const started = latch();
    const upload = latch();
    const original = put.getMockImplementation()!;
    put.mockImplementationOnce(async (input) => {
      started.release();
      await upload.wait;
      return original(input);
    });
    const input = body("held upload");
    const first = store.put(input);
    await started.wait;
    await second.put(body("evict completed one"));
    await second.put(body("evict completed two"));
    const duplicate = second.put(input);
    upload.release();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(a).toEqual(b);
    expect(put).toHaveBeenCalledTimes(3);
  });

  it.each([
    { maxActiveWrites: 1 },
    { maxActiveWriteBytes: 4 },
  ])("rejects excess work and restores capacity after a failed write: %j", async (limits) => {
    const { store, deps, put } = fixture(limits);
    const other = createEvidenceStore(deps);
    const started = latch();
    const upload = latch();
    put.mockImplementationOnce(async () => {
      started.release();
      await upload.wait;
      throw new Error("upload failed");
    });
    const first = store.put(body("full"));
    const failed = expect(first).rejects.toThrow("upload failed");
    await started.wait;
    await expect(other.put(body("next"))).rejects.toBeInstanceOf(EvidenceStoreBusyError);
    upload.release();
    await failed;
    await expect(other.put(body("next"))).resolves.toHaveProperty("ref");
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("rewrites a remembered object after retention deletes it", async () => {
    const { store, put, objects } = fixture();
    const input = body("retention deletion");
    const first = await store.put(input);
    objects.clear();
    const second = await store.put(input);
    expect(first).toEqual(second);
    expect(put).toHaveBeenCalledTimes(2);
    expect((await store.getBody(scope, second.ref)).bytes).toEqual(input.bytes);
  });

  it("does not claim durability when the presence check fails", async () => {
    const { store, put, get } = fixture();
    const input = body("presence unavailable");
    await store.put(input);
    get.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(store.put(input)).rejects.toThrow("storage unavailable");
    expect(put).toHaveBeenCalledTimes(1);
    await store.put(input);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("keeps write hints separate for different storage adapters", async () => {
    const a = fixture();
    const b = fixture();
    const input = body("different stores");
    await a.store.put(input);
    await b.store.put(input);
    expect(a.put).toHaveBeenCalledTimes(1);
    expect(b.put).toHaveBeenCalledTimes(1);
  });

  it("refuses invalid limits and conflicting limits on one adapter", () => {
    expect(() => fixture({ maxActiveWrites: 0 })).toThrow(RangeError);
    expect(() => fixture({ maxActiveWriteBytes: Infinity })).toThrow(RangeError);
    const { deps } = fixture();
    expect(() => createEvidenceStore({ ...deps, maxActiveWrites: 1 })).toThrow(RangeError);
  });
});

describe("evidence body read limits", () => {
  it.each([null, 2, 100])("cancels an oversized scratch stream with reported size %s", async (sizeBytes) => {
    const { store, get } = fixture();
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(5));
    });
    const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    get.mockResolvedValueOnce({ body: stream, contentType: null, sizeBytes });
    await expect(store.getScratch(scope, "job", "manifest", { maxBytes: 8 }))
      .rejects.toBeInstanceOf(EvidenceBodyTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(pull).toHaveBeenCalledTimes(sizeBytes === 100 ? 0 : 2);
  });

  it("reads a scratch object at its encrypted byte limit", async () => {
    const { store, objects, get } = fixture();
    const bytes = new TextEncoder().encode("scratch round trip");
    await store.putScratch({ scope, jobRunId: "job", name: "chunk-0", contentType: "text/plain", bytes });
    const encrypted = objects.values().next().value!;
    await expect(store.getScratch(scope, "job", "chunk-0", { maxBytes: encrypted.byteLength }))
      .resolves.toMatchObject({ bytes, contentType: "text/plain" });
    get.mockClear();
    await expect(store.getScratch(scope, "job", "chunk-0", { maxBytes: -1 }))
      .rejects.toThrow(RangeError);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([null, 2, 100])("cancels an oversized stream with reported size %s", async (sizeBytes) => {
    const { store, get } = fixture();
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(5));
    });
    const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    get.mockResolvedValueOnce({ body: stream, contentType: null, sizeBytes });
    const ref = evidenceBodyRef(crypto.keyId, "0".repeat(64));
    await expect(store.getBody(scope, ref, { maxBytes: 8 })).rejects.toBeInstanceOf(EvidenceBodyTooLargeError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(pull).toHaveBeenCalledTimes(sizeBytes === 100 ? 0 : 2);
  });

  it("reads an object at the exact encrypted byte limit", async () => {
    const { store, objects } = fixture();
    const input = body("bounded round trip");
    const { ref } = await store.put(input);
    const bytes = objects.values().next().value!;
    const result = await store.getBody(scope, ref, { maxBytes: bytes.byteLength });
    expect(result.bytes).toEqual(input.bytes);
    await expect(store.getBody(scope, ref, { maxBytes: -1 })).rejects.toThrow(RangeError);
  });

  it("returns a view over framed bytes without copying the plaintext", () => {
    const backing = new Uint8Array([99, 0, 1, 120, 1, 2, 99]);
    const plaintext = backing.subarray(1, 6);
    const parsed = parseFrameBodyPlaintext(plaintext);
    expect(parsed.contentType).toBe("x");
    expect(parsed.bytes).toEqual(new Uint8Array([1, 2]));
    expect(parsed.bytes.buffer).toBe(backing.buffer);
    expect(parsed.bytes.byteOffset).toBe(4);
  });
});
