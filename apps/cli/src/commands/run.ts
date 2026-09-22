/**
 * `oxagen run export <run-id>`, `oxagen run export-status <export-id>`,
 * `oxagen run download <export-id>` and `oxagen run chain <run-id>`: the CLI
 * parity surfaces for `export_run`, `get_run_export` and `get_run_chain`
 * (Mission Control spec §13.4, §14.1; ADR-058).
 *
 * `export` queues the signed, offline-verifiable evidence bundle for one
 * sealed run and prints the export id. The bundle is built off the request
 * path. `export-status` reads where that job stands, and `download` fetches
 * the ready bundle, checks its sha256 against the digest the platform
 * recorded, and writes it to disk for `oxagen verify`.
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload
 * as one line on stdout; pretty mode prints the id and what to do next;
 * failures are uniform stderr error lines (exit 1 for an API failure).
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiPostOrThrow } from "../lib/api.js";
import { getApiUrl } from "../lib/config.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

/** Mirrors the `export_run` contract output. */
interface RunExportResult {
  exportId: string;
  status: "queued";
}

export async function runExport(
  runId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunExportResult;
  try {
    result = await apiPostOrThrow<RunExportResult>("runs/export", { runId });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(`Export ${result.exportId} queued for ${runId}.`);
  writer.write(
    `The bundle holds the frames as NDJSON, the Merkle root, the attestation, the verifying key, and a verifier script. Check on it with \`oxagen run export-status ${result.exportId}\`.`,
  );
}

/** Mirrors the `get_run_export` contract output. */
export interface RunExportStatusResult {
  exportId: string;
  runId: string;
  status: "queued" | "building" | "ready" | "failed";
  createdAt: string;
  completedAt: string | null;
  bundleDigest: string | null;
  bundleBytes: number | null;
  merkleRoot: string | null;
  frameCount: number | null;
  error: string | null;
  download: { url: string; expiresAt: string } | null;
}

/**
 * The download URL as a fetchable address. The server answers an absolute
 * URL when it knows its own origin, else a path such as
 * `/v1/run-exports/download?token=…`. A path resolves against the configured
 * API origin, never the org/workspace-scoped base: the token alone authorises
 * the fetch.
 */
export function resolveDownloadUrl(url: string, apiUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = apiUrl.replace(/\/+$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

function formatBytes(bytes: number | null): string {
  return bytes === null
    ? "not recorded"
    : `${bytes.toLocaleString("en-US")} bytes`;
}

/**
 * `oxagen run export-status <export-id>`: where one export stands. Once the
 * bundle is ready it prints the download link, when the link expires, and the
 * command that fetches and checks it.
 */
export async function runExportStatus(
  exportId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunExportStatusResult;
  try {
    result = await apiPostOrThrow<RunExportStatusResult>("runs/export-status", {
      exportId,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `Export ${result.exportId} for ${result.runId}: ${result.status}`,
  );
  if (result.status === "queued" || result.status === "building") {
    writer.write(
      `The bundle is not built yet. Run \`oxagen run export-status ${result.exportId}\` again to check.`,
    );
    return;
  }
  if (result.status === "failed") {
    writer.write(`Error: ${result.error ?? "the job recorded no error"}`);
    writer.write(
      `Queue a new export with \`oxagen run export ${result.runId}\`.`,
    );
    return;
  }
  writer.write(`Size: ${formatBytes(result.bundleBytes)}`);
  writer.write(`Digest: ${result.bundleDigest ?? "not recorded"}`);
  writer.write(`Frames: ${result.frameCount ?? "not recorded"}`);
  writer.write(`Merkle root: ${result.merkleRoot ?? "not recorded"}`);
  if (result.download) {
    writer.write(
      `Download: ${resolveDownloadUrl(result.download.url, getApiUrl())}`,
    );
    writer.write(`Link expires: ${result.download.expiresAt}`);
  }
  writer.write(
    `Fetch and check it with \`oxagen run download ${result.exportId}\`.`,
  );
}

/** What `oxagen run download --json` prints. */
interface RunDownloadResult {
  exportId: string;
  runId: string;
  path: string;
  bytes: number;
  bundleDigest: string;
}

function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * `oxagen run download <export-id>`: fetch a ready bundle and write it to
 * disk.
 *
 * The export is read first, so a queued, building or failed export is
 * refused with its status before any fetch. The bytes are hashed before
 * they are written: a bundle whose sha256 differs from the recorded
 * `bundleDigest`, or from the `X-Bundle-Digest` header the download route
 * sends, is refused and nothing is written.
 */
export async function runDownload(
  exportId: string,
  opts: { json?: boolean; out?: string } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let status: RunExportStatusResult;
  try {
    status = await apiPostOrThrow<RunExportStatusResult>("runs/export-status", {
      exportId,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (status.status !== "ready") {
    const why =
      status.status === "failed"
        ? `Export ${exportId} failed: ${status.error ?? "the job recorded no error"}.`
        : `Export ${exportId} is ${status.status}, not ready. Run \`oxagen run export-status ${exportId}\` to check again.`;
    out.error(why, "not_ready");
    return;
  }
  if (!status.download || !status.bundleDigest) {
    out.error(
      `Export ${exportId} is ready but the platform sent no download link or digest.`,
      "not_ready",
    );
    return;
  }

  const url = resolveDownloadUrl(status.download.url, getApiUrl());
  let bytes: Uint8Array;
  let headerDigest: string | null;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      out.error(
        `The download answered ${res.status}: ${body}. The link may have expired. Run \`oxagen run download ${exportId}\` again for a fresh one.`,
        "download",
      );
      return;
    }
    headerDigest = res.headers.get("x-bundle-digest");
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    out.error(err, "download");
    return;
  }

  const actual = sha256Of(bytes);
  if (actual !== status.bundleDigest) {
    out.error(
      `The downloaded bytes hash to ${actual}, the platform recorded ${status.bundleDigest}. Nothing was written.`,
      "digest_mismatch",
    );
    return;
  }
  if (headerDigest !== null && headerDigest !== actual) {
    out.error(
      `The downloaded bytes hash to ${actual}, the response header says ${headerDigest}. Nothing was written.`,
      "digest_mismatch",
    );
    return;
  }

  const path = resolve(opts.out ?? `${status.runId}-${exportId}.zip`);
  try {
    writeFileSync(path, bytes);
  } catch (err) {
    out.error(err, "write");
    return;
  }
  const result: RunDownloadResult = {
    exportId,
    runId: status.runId,
    path,
    bytes: bytes.byteLength,
    bundleDigest: actual,
  };
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(`Wrote ${path} (${formatBytes(bytes.byteLength)}).`);
  writer.write(`Digest ${actual} matches the recorded bundle digest.`);
  writer.write(`Check every frame offline with \`oxagen verify ${path}\`.`);
}

/** Mirrors the `get_run_chain` contract output, as far as the CLI prints it. */
interface RunChainResult {
  runId: string;
  hashRule: string;
  frameCount: number;
  merkleRoot: string | null;
  checkpoints: { seq: string; chainHead: string; signedAt: string }[];
  gaps: {
    missingSequences: { from: string; to: string }[];
    missingFrameCount: number;
    missingBodies: number;
    recorded: string[];
  };
  seals: { sealedAt: string; terminalStatus: string }[];
  enforcementTier: string;
  recordedGrade: string | null;
  ladder: { grade: string; met: boolean; reason: string }[];
  complete: boolean;
}

/**
 * `oxagen run chain <run-id>` — what makes one run's record tamper-evident.
 *
 * Pretty mode prints the chain rule and root, then the ladder with the reason
 * each rung is or is not reached, then the gaps. The recorded grade is printed
 * as the seal wrote it and never recomputed (spec §8.4).
 */
export async function runChain(
  runId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunChainResult;
  try {
    result = await apiPostOrThrow<RunChainResult>("runs/chain", { runId });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `${result.runId}: ${result.frameCount} frames, ${result.hashRule}`,
  );
  writer.write(`Merkle root: ${result.merkleRoot ?? "not recorded"}`);
  writer.write(
    `Observed at: ${result.enforcementTier} · recorded grade: ${result.recordedGrade ?? "not recorded"}`,
  );
  writer.write("");
  writer.write("Replay ladder");
  for (const rung of result.ladder) {
    writer.write(`  ${rung.met ? "✓" : "·"} ${rung.grade}: ${rung.reason}`);
  }
  writer.write("");
  const { gaps } = result;
  if (
    gaps.missingFrameCount === 0 &&
    gaps.missingBodies === 0 &&
    gaps.recorded.length === 0
  ) {
    writer.write("No gaps found in what was read.");
  } else {
    writer.write(
      `Gaps: ${gaps.missingFrameCount} missing frames, ${gaps.missingBodies} missing bodies${
        gaps.recorded.length > 0
          ? `, recorded: ${gaps.recorded.join(", ")}`
          : ""
      }`,
    );
    for (const gap of gaps.missingSequences) {
      writer.write(`  sequences ${gap.from} to ${gap.to}`);
    }
  }
  if (result.checkpoints.length > 0) {
    writer.write(`${result.checkpoints.length} signed checkpoint(s).`);
  }
  if (!result.complete) {
    writer.write(
      "The walk was cut short: these are the gaps of a prefix, not of the whole run.",
    );
  }
}
