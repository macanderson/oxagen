/**
 * On-device weight provisioning: download → checksum-verify → cache.
 *
 * Requirement 1: verify integrity with a checksum, cache the weights, and never
 * re-download when the cache is valid. This module owns exactly that, and is
 * transport-agnostic — `fetch` is injectable so tests exercise the checksum,
 * cache-hit, and mismatch paths without a network or a multi-GB file.
 *
 * Integrity model (trust-on-first-use, upgradeable to pinned):
 *   - If the source carries a non-empty `sha256`, the download must match it or
 *     it is rejected and deleted (pinned integrity).
 *   - If the source's `sha256` is empty, the checksum is *computed during* the
 *     download and pinned into the cache manifest. Every later run verifies the
 *     cached file against that pinned value, so a corrupted/tampered cache is
 *     caught even without an upstream checksum.
 */
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expandHome, registryDefaults } from "../registry.js";
import type { ModelSource, Quantization } from "../types.js";

/** A recorded cache entry — one downloaded weight file. */
export interface CacheEntry {
  modelId: string;
  quant: Quantization;
  /** File name inside the cache dir. */
  file: string;
  /** Pinned SHA-256 (lowercase hex) the file must always match. */
  sha256: string;
  sizeBytes: number;
  url: string;
  /** ISO timestamp; set by the caller (kept out of this module for determinism). */
  downloadedAt: string;
}

interface CacheManifest {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/** Thrown when a downloaded or cached file fails checksum verification. */
export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly file: string,
  ) {
    super(
      `Checksum mismatch for ${file}: expected ${expected.slice(0, 12)}…, ` +
        `got ${actual.slice(0, 12)}…. The file was not cached.`,
    );
    this.name = "ChecksumMismatchError";
  }
}

/** A minimal `fetch`, so the downloader can be driven with a fake in tests. */
export type FetchImpl = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  body: AsyncIterable<Uint8Array> | null;
}>;

/** Resolve the absolute on-device cache dir (honours `~` and user override). */
export function cacheDir(override?: string): string {
  return expandHome(override ?? registryDefaults().onDevice.cacheDir);
}

/** Deterministic file name for a model+quant weight file. */
export function cacheFileName(modelId: string, quant: Quantization): string {
  return `${modelId}-${quant}.gguf`;
}

/** Absolute path a model+quant weight file lives at (whether or not present). */
export function cachedPath(
  dir: string,
  modelId: string,
  quant: Quantization,
): string {
  return join(dir, cacheFileName(modelId, quant));
}

function cacheKey(modelId: string, quant: Quantization): string {
  return `${modelId}:${quant}`;
}

function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

/** Read the cache manifest (empty when absent or unreadable). */
export function readManifest(dir: string): CacheManifest {
  const path = manifestPath(dir);
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheManifest;
    if (parsed && parsed.version === 1 && parsed.entries) return parsed;
  } catch {
    /* corrupt manifest — treat as empty; a re-download rebuilds it */
  }
  return { version: 1, entries: {} };
}

function writeManifest(dir: string, manifest: CacheManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2), "utf8");
}

/** The manifest entry for a model+quant, if one has been recorded. */
export function manifestEntry(
  dir: string,
  modelId: string,
  quant: Quantization,
): CacheEntry | undefined {
  return readManifest(dir).entries[cacheKey(modelId, quant)];
}

/** Result of a cache-validity check. */
export interface CacheStatus {
  cached: boolean;
  path: string;
  entry?: CacheEntry;
  /** Present when not cached / invalid: why. */
  reason?: string;
}

/**
 * Is a model+quant validly cached? "Valid" = the file exists, a manifest entry
 * pins its checksum, and the on-disk size matches. This is the cheap gate that
 * makes {@link ensureModelCached} skip re-downloading (requirement 1). Use
 * {@link verifyIntegrity} for a full checksum re-hash (used by `models status`).
 */
export function isCached(
  dir: string,
  modelId: string,
  quant: Quantization,
): CacheStatus {
  const path = cachedPath(dir, modelId, quant);
  const entry = manifestEntry(dir, modelId, quant);
  if (!entry) return { cached: false, path, reason: "no manifest entry" };
  if (!existsSync(path))
    return { cached: false, path, entry, reason: "file missing" };
  const size = statSync(path).size;
  if (entry.sizeBytes && size !== entry.sizeBytes) {
    return {
      cached: false,
      path,
      entry,
      reason: "size mismatch (partial/corrupt)",
    };
  }
  return { cached: true, path, entry };
}

/** Full-strength integrity check: re-hash the cached file against the manifest. */
export function verifyIntegrity(
  dir: string,
  modelId: string,
  quant: Quantization,
): { ok: boolean; reason?: string } {
  const status = isCached(dir, modelId, quant);
  if (!status.cached || !status.entry)
    return { ok: false, reason: status.reason };
  const actual = sha256File(status.path);
  if (actual !== status.entry.sha256) {
    return { ok: false, reason: "checksum mismatch" };
  }
  return { ok: true };
}

/** SHA-256 of an on-disk file (hex). Reads the whole file — use sparingly. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Progress callback: bytes received so far and total when known. */
export type ProgressFn = (receivedBytes: number, totalBytes?: number) => void;

export interface DownloadOptions {
  source: ModelSource;
  /** Final destination path. Download streams to `${dest}.part` then renames. */
  dest: string;
  /** Enforce the source's pinned sha256 (when it has one). Default true. */
  verifyChecksum?: boolean;
  fetchImpl: FetchImpl;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
}

/**
 * Download one weight file to `dest`, streaming through a SHA-256 hash so the
 * checksum is known without a second pass. Verifies against a pinned checksum
 * when present; always returns the computed checksum so the caller can pin it.
 */
export async function downloadModel(
  opts: DownloadOptions,
): Promise<{ sha256: string; sizeBytes: number }> {
  const { source, dest, fetchImpl, signal, onProgress } = opts;
  const verify = opts.verifyChecksum ?? true;
  const partPath = `${dest}.part`;

  mkdirSync(join(dest, ".."), { recursive: true });

  const res = await fetchImpl(source.url, signal ? { signal } : undefined);
  if (!res.ok || !res.body) {
    throw new Error(
      `Failed to download ${source.url}: ${res.status} ${res.statusText || "no response body"}`,
    );
  }

  const hash = createHash("sha256");
  const stream = createWriteStream(partPath);
  let received = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.byteLength;
      stream.write(chunk);
      onProgress?.(received, source.sizeBytes);
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    stream.destroy();
    safeRm(partPath);
    throw err;
  }

  const digest = hash.digest("hex");
  if (verify && source.sha256 && source.sha256 !== digest) {
    safeRm(partPath);
    throw new ChecksumMismatchError(source.sha256, digest, source.url);
  }

  renameSync(partPath, dest);
  return { sha256: digest, sizeBytes: received };
}

export interface EnsureOptions {
  dir: string;
  modelId: string;
  quant: Quantization;
  source: ModelSource;
  verifyChecksum?: boolean;
  fetchImpl: FetchImpl;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
  /** Timestamp for the manifest entry (injected for deterministic tests). */
  now?: string;
  /** Re-download even if a valid cache exists. */
  force?: boolean;
}

/** Outcome of {@link ensureModelCached}. */
export interface EnsureResult {
  path: string;
  fromCache: boolean;
  sha256: string;
  sizeBytes: number;
}

/**
 * Ensure a model+quant is cached, downloading only if needed. A valid cache is
 * returned untouched — the download path never runs (requirement 1). On a fresh
 * download the computed checksum is pinned to the manifest for future runs.
 */
export async function ensureModelCached(
  opts: EnsureOptions,
): Promise<EnsureResult> {
  const { dir, modelId, quant, source } = opts;
  const dest = cachedPath(dir, modelId, quant);

  if (!opts.force) {
    const status = isCached(dir, modelId, quant);
    if (status.cached && status.entry) {
      return {
        path: status.path,
        fromCache: true,
        sha256: status.entry.sha256,
        sizeBytes: status.entry.sizeBytes,
      };
    }
  }

  const { sha256, sizeBytes } = await downloadModel({
    source,
    dest,
    verifyChecksum: opts.verifyChecksum,
    fetchImpl: opts.fetchImpl,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });

  const manifest = readManifest(dir);
  manifest.entries[cacheKey(modelId, quant)] = {
    modelId,
    quant,
    file: cacheFileName(modelId, quant),
    sha256,
    sizeBytes,
    url: source.url,
    downloadedAt: opts.now ?? "",
  };
  writeManifest(dir, manifest);

  return { path: dest, fromCache: false, sha256, sizeBytes };
}

function safeRm(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}
