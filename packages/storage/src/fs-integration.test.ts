// fs-integration.test.ts — route-level proof for the filesystem storage driver.
//
// Unlike client.test.ts (which mocks the driver factory) and fs-driver.test.ts
// (which constructs the adapter directly), this test exercises the FULL path the
// chat-attachment routes actually take:
//
//   storage()  →  resolveAdapter()  →  createFsAdapter()  →  real filesystem
//
// with STORAGE_DRIVER=fs and NO BLOB_READ_WRITE_TOKEN. It is the hermetic stand-in
// for apps/app/e2e/chat-attachments.spec.ts: the upload route's persistence
// chokepoint calls `storage().put({ key, body, access: "private" })` and the
// asset-serve route streams the bytes back via `storage().get(storageKey)`. This
// round-trips a real PNG through the singleton exactly as those routes do, using
// the same key shape persistGeneratedAsset builds
// (`generated/<kind>s/<orgId>/<uuid>.<ext>`), proving the storage seam works end
// to end without a browser, a database, or a Vercel Blob token.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Resolve STORAGE_DRIVER / STORAGE_FS_ROOT straight from process.env so the REAL
// resolveAdapter() + REAL createFsAdapter() run (only the env accessor is stubbed
// to avoid pulling the full baseEnvSchema, which requires unrelated prod vars).
vi.mock("@oxagen/config/env", () => ({
  requireEnv: (keys: readonly string[]): Record<string, string | undefined> =>
    Object.fromEntries(keys.map((k) => [k, process.env[k]])),
}));

// A real 1×1 transparent PNG — the identical fixture the e2e uploads. Its 8-byte
// signature is the fidelity checkpoint after the filesystem round-trip.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let root: string;
const prevDriver = process.env.STORAGE_DRIVER;
const prevRoot = process.env.STORAGE_FS_ROOT;
const prevToken = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oxagen-fs-integ-"));
  process.env.STORAGE_DRIVER = "fs";
  process.env.STORAGE_FS_ROOT = root;
  // The whole point: no Vercel Blob token anywhere (mirrors CI + local dev).
  delete process.env.BLOB_READ_WRITE_TOKEN;
  vi.resetModules();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  // Restore the ambient env so sibling test files are unaffected.
  if (prevDriver === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = prevDriver;
  if (prevRoot === undefined) delete process.env.STORAGE_FS_ROOT;
  else process.env.STORAGE_FS_ROOT = prevRoot;
  if (prevToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = prevToken;
});

/** Buffer a web stream so we can assert exact bytes. */
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

describe("fs storage driver — chat-attachment route seam (integration)", () => {
  it("storage() resolves the fs adapter with NO Vercel Blob token", async () => {
    const { storage } = await import("./client");
    expect(() => storage()).not.toThrow();
    expect(storage().driver).toBe("fs");
  });

  it("round-trips an uploaded PNG through the singleton exactly as the routes do", async () => {
    const { storage } = await import("./client");
    const store = storage();

    // Key shape produced by persistGeneratedAsset for a chat image attachment.
    const orgId = randomUUID();
    const key = `generated/images/${orgId}/${randomUUID()}.png`;
    const bytes = new Uint8Array(Buffer.from(PNG_1X1_BASE64, "base64"));

    // 1) Upload route seam: private put (the access level the upload route uses).
    const put = await store.put({
      key,
      body: bytes,
      contentType: "image/png",
      access: "private",
    });
    expect(put.access).toBe("private");
    expect(put.bytes).toBe(bytes.byteLength);
    // persistGeneratedAsset persists `key` as storageKey and reads it back later.
    const storageKey = put.key;
    expect(storageKey).toBe(key);

    // 2) Asset-serve route seam: stream the bytes back by storageKey.
    const got = await store.get(storageKey);
    const served = await drain(got.body);

    // The served bytes must be byte-identical to what was uploaded — this is the
    // thumbnail the e2e asserts renders after reload.
    expect(served.equals(Buffer.from(bytes))).toBe(true);
    expect(served.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(got.sizeBytes).toBe(bytes.byteLength);
  });

  it("serve seam returns a not-found error for an unknown asset key", async () => {
    const { storage } = await import("./client");
    const { StorageNotFoundError } = await import("./errors");
    await expect(
      storage().get(`generated/images/${randomUUID()}/missing.png`),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});
