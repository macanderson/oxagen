import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsAdapter } from "./fs-driver";
import { StorageNotFoundError } from "./errors";

/** Buffer the whole web stream so tests can assert exact bytes. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

describe("createFsAdapter", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oxagen-fs-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the driver name", () => {
    expect(createFsAdapter(root).driver).toBe("fs");
  });

  // ── put/get round-trip ──────────────────────────────────────────────────────

  it("put then get round-trips the object: url=key, byte length, stream body", async () => {
    const adapter = createFsAdapter(root);
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    const put = await adapter.put({
      key: "generated/images/org-1/asset.png",
      body,
      contentType: "image/png",
      access: "private",
    });

    // For the fs driver url === key (no CDN) and access is echoed back.
    expect(put).toEqual({
      url: "generated/images/org-1/asset.png",
      key: "generated/images/org-1/asset.png",
      bytes: 5,
      access: "private",
    });

    const got = await adapter.get("generated/images/org-1/asset.png");
    expect(got.sizeBytes).toBe(5);
    expect(got.contentType).toBeNull();
    expect(await drain(got.body)).toEqual(Buffer.from(body));
  });

  it("defaults access to 'public' when omitted", async () => {
    const adapter = createFsAdapter(root);
    const result = await adapter.put({
      key: "a/b.bin",
      body: new Uint8Array([9]),
    });
    expect(result.access).toBe("public");
  });

  it("nests directories for a deep key", async () => {
    const adapter = createFsAdapter(root);
    await adapter.put({
      key: "deep/nested/dir/path/file.bin",
      body: new Uint8Array([7]),
    });
    expect(existsSync(join(root, "deep/nested/dir/path/file.bin"))).toBe(true);
  });

  // ── byte fidelity on binary (PNG magic bytes) ────────────────────────────────

  it("preserves exact binary bytes including the PNG magic header", async () => {
    const adapter = createFsAdapter(root);
    // 8-byte PNG signature + a couple of arbitrary bytes.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
    ]);

    await adapter.put({
      key: "img/logo.png",
      body: png,
      contentType: "image/png",
    });
    const got = await adapter.get("img/logo.png");
    const out = await drain(got.body);

    expect(out.length).toBe(png.length);
    expect([...out]).toEqual([...png]);
    // The canonical PNG signature must be byte-identical after the round-trip.
    expect(out.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("accepts a Blob body and reports its size", async () => {
    const adapter = createFsAdapter(root);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "image/webp",
    });
    const result = await adapter.put({ key: "k/blob.webp", body: blob });
    expect(result.bytes).toBe(4);
    expect(await drain((await adapter.get("k/blob.webp")).body)).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("accepts an ArrayBuffer body", async () => {
    const adapter = createFsAdapter(root);
    const ab = new Uint8Array([5, 6, 7]).buffer;
    const result = await adapter.put({ key: "k/ab.bin", body: ab });
    expect(result.bytes).toBe(3);
  });

  it("get reports null sizeBytes for a zero-length object", async () => {
    const adapter = createFsAdapter(root);
    await adapter.put({ key: "empty.bin", body: new Uint8Array([]) });
    expect((await adapter.get("empty.bin")).sizeBytes).toBeNull();
  });

  // ── delete ───────────────────────────────────────────────────────────────────

  it("delete removes the object; a subsequent get throws StorageNotFoundError", async () => {
    const adapter = createFsAdapter(root);
    await adapter.put({ key: "tmp/x.bin", body: new Uint8Array([1]) });
    await adapter.delete("tmp/x.bin");
    await expect(adapter.get("tmp/x.bin")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it("delete is idempotent — deleting a missing key does not throw", async () => {
    const adapter = createFsAdapter(root);
    await expect(adapter.delete("never/existed.bin")).resolves.toBeUndefined();
  });

  // ── get on a missing key ──────────────────────────────────────────────────────

  it("get throws StorageNotFoundError when the key does not exist", async () => {
    const adapter = createFsAdapter(root);
    await expect(adapter.get("does/not/exist.png")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  // ── path-traversal rejection ──────────────────────────────────────────────────

  it("rejects a key that escapes the root via ..", async () => {
    const adapter = createFsAdapter(root);
    await expect(
      adapter.put({ key: "../escape.txt", body: new Uint8Array([1]) }),
    ).rejects.toThrow(/outside the storage root/);
  });

  it("rejects a deep-traversal key that resolves above the root", async () => {
    const adapter = createFsAdapter(root);
    await expect(
      adapter.get("a/b/../../../../../../etc/passwd"),
    ).rejects.toThrow(/outside the storage root/);
  });

  it("rejects an absolute key", async () => {
    const adapter = createFsAdapter(root);
    await expect(
      adapter.put({ key: "/etc/passwd", body: new Uint8Array([1]) }),
    ).rejects.toThrow(/must be relative/);
  });

  it("rejects an empty key and a null-byte key", async () => {
    const adapter = createFsAdapter(root);
    await expect(
      adapter.put({ key: "", body: new Uint8Array([1]) }),
    ).rejects.toThrow(/non-empty/);
    await expect(adapter.get("a\0b")).rejects.toThrow(/null byte/);
  });

  it("does not leak traversal writes outside the root", async () => {
    const adapter = createFsAdapter(root);
    // Even a mixed key that dips out then back in is rejected the moment it
    // escapes — never silently written to a sibling of the root.
    await expect(
      adapter.put({
        key: `../${"oxagen-fs-test-escape"}/pwned.bin`,
        body: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/outside the storage root/);
  });

  // ── default root (STORAGE_FS_ROOT unset) ──────────────────────────────────────

  it("falls back to an OS-tmp root when no root is provided", async () => {
    const adapter = createFsAdapter(undefined);
    const key = `oxagen-fs-default-test/${Date.now()}.bin`;
    try {
      await adapter.put({ key, body: new Uint8Array([42]) });
      const got = await adapter.get(key);
      expect(await drain(got.body)).toEqual(Buffer.from([42]));
    } finally {
      await adapter.delete(key);
      // Clean the created default-root subtree.
      rmSync(join(tmpdir(), "oxagen-storage", "oxagen-fs-default-test"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("resolves a relative STORAGE_FS_ROOT against cwd", async () => {
    // A relative root is documented but discouraged; still, it must resolve and
    // work (anchored at process.cwd()).
    const rel = `.oxagen-fs-rel-${Date.now()}`;
    const adapter = createFsAdapter(rel);
    try {
      await adapter.put({ key: "r/x.bin", body: new Uint8Array([3]) });
      const abs = join(process.cwd(), rel, "r/x.bin");
      expect(existsSync(abs)).toBe(true);
      expect(await readFile(abs)).toEqual(Buffer.from([3]));
    } finally {
      rmSync(join(process.cwd(), rel), { recursive: true, force: true });
    }
  });
});
