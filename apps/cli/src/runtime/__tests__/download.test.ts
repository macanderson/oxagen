import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedPath,
  ChecksumMismatchError,
  downloadModel,
  ensureModelCached,
  isCached,
  manifestEntry,
  verifyIntegrity,
  type FetchImpl,
} from "../provisioning/download.js";
import type { ModelSource } from "../types.js";

const CONTENT = Buffer.from(
  "fake gguf weight bytes — enough to hash".repeat(4),
);
const SHA = createHash("sha256").update(CONTENT).digest("hex");

let dir: string;

/** A fake fetch that streams `body` in two chunks. */
function fakeFetch(body: Buffer, ok = true): FetchImpl {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? "OK" : "Not Found",
    body: ok
      ? (async function* () {
          yield new Uint8Array(body.subarray(0, 10));
          yield new Uint8Array(body.subarray(10));
        })()
      : null,
  }));
}

function source(sha = ""): ModelSource {
  return {
    url: "https://example.test/model.gguf",
    sha256: sha,
    sizeBytes: CONTENT.length,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-dl-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("downloadModel", () => {
  it("streams to disk and returns the computed checksum", async () => {
    const dest = join(dir, "m.gguf");
    const res = await downloadModel({
      source: source(),
      dest,
      fetchImpl: fakeFetch(CONTENT),
    });
    expect(res.sha256).toBe(SHA);
    expect(res.sizeBytes).toBe(CONTENT.length);
    expect(readFileSync(dest)).toEqual(CONTENT);
  });

  it("rejects a checksum mismatch and does not leave the file", async () => {
    const dest = join(dir, "m.gguf");
    await expect(
      downloadModel({
        source: source("deadbeef"),
        dest,
        fetchImpl: fakeFetch(CONTENT),
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("throws a clear error on a non-ok response", async () => {
    await expect(
      downloadModel({
        source: source(),
        dest: join(dir, "m.gguf"),
        fetchImpl: fakeFetch(CONTENT, false),
      }),
    ).rejects.toThrow(/Failed to download/);
  });
});

describe("ensureModelCached", () => {
  it("downloads, caches, and records a manifest entry with the pinned checksum", async () => {
    const fetchImpl = fakeFetch(CONTENT);
    const res = await ensureModelCached({
      dir,
      modelId: "m",
      quant: "q4",
      source: source(),
      fetchImpl,
      now: "2026-07-01T00:00:00Z",
    });
    expect(res.fromCache).toBe(false);
    expect(res.sha256).toBe(SHA);
    expect(res.path).toBe(cachedPath(dir, "m", "q4"));
    const entry = manifestEntry(dir, "m", "q4");
    expect(entry?.sha256).toBe(SHA);
    expect(entry?.downloadedAt).toBe("2026-07-01T00:00:00Z");
  });

  it("never re-downloads when the cache is valid", async () => {
    const fetchImpl = fakeFetch(CONTENT);
    await ensureModelCached({
      dir,
      modelId: "m",
      quant: "q4",
      source: source(),
      fetchImpl,
    });
    const again = await ensureModelCached({
      dir,
      modelId: "m",
      quant: "q4",
      source: source(),
      fetchImpl,
    });
    expect(again.fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("re-downloads when force is set", async () => {
    const fetchImpl = fakeFetch(CONTENT);
    await ensureModelCached({
      dir,
      modelId: "m",
      quant: "q4",
      source: source(),
      fetchImpl,
    });
    await ensureModelCached({
      dir,
      modelId: "m",
      quant: "q4",
      source: source(),
      fetchImpl,
      force: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("isCached / verifyIntegrity", () => {
  it("verifies a good cache and detects tampering", async () => {
    await ensureModelCached({
      dir,
      modelId: "m",
      quant: "q4",
      source: source(),
      fetchImpl: fakeFetch(CONTENT),
    });
    expect(isCached(dir, "m", "q4").cached).toBe(true);
    expect(verifyIntegrity(dir, "m", "q4").ok).toBe(true);

    // Corrupt the cached file: same size, different bytes → checksum fails.
    const p = cachedPath(dir, "m", "q4");
    const tampered = Buffer.from(CONTENT);
    tampered[0] = tampered[0]! ^ 0xff;
    writeFileSync(p, tampered);
    expect(verifyIntegrity(dir, "m", "q4").ok).toBe(false);
  });

  it("treats a size mismatch as not cached", async () => {
    await ensureModelCached({
      dir,
      modelId: "m",
      quant: "q4",
      source: source(),
      fetchImpl: fakeFetch(CONTENT),
    });
    writeFileSync(cachedPath(dir, "m", "q4"), Buffer.from("short"));
    const status = isCached(dir, "m", "q4");
    expect(status.cached).toBe(false);
    expect(status.reason).toMatch(/size mismatch/);
  });

  it("reports no manifest entry for an unknown model", () => {
    expect(isCached(dir, "ghost", "q8").cached).toBe(false);
    expect(verifyIntegrity(dir, "ghost", "q8").ok).toBe(false);
  });
});
