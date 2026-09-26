/**
 * `oxagen run list`, `oxagen run show <run-id>`, `oxagen run export <run-id>`,
 * `oxagen run export-status <export-id>`, `oxagen run download <export-id>`,
 * `oxagen run chain <run-id>` and `oxagen run turns <run-id>`: the CLI parity
 * surfaces for `list_runs`, `get_run`, `export_run`, `get_run_export`,
 * `get_run_chain` and `get_run_turns` (Mission Control spec §12.9, §13.4,
 * §14.1; ADR-058).
 *
 * `list` prints the workspace's runs, newest first, one page at a time.
 *
 * `show` prints one run's header, the pause in force, and the first page of
 * its frames, as `get_run` answers them.
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
import { formatUsd } from "@oxagen/billing/rate-card";
import { apiPostOrThrow, printTable } from "../lib/api.js";
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

/** Mirrors the `get_run_turns` contract output. */
interface RunTurnsResult {
  runId: string;
  turns: {
    turn: number;
    seq: string;
    at: string;
    frames: number;
    modelSteps: number;
    toolSteps: number;
    cost: { micros: string; currency: string } | null;
    cumulativeCost: { micros: string; currency: string } | null;
    tokens: { inputUncached: number | null; cacheRead: number | null };
  }[];
  complete: boolean;
}

const NOT_RECORDED = "not recorded";

function usdOf(cost: { micros: string } | null): string {
  return cost === null ? NOT_RECORDED : formatUsd(Number(cost.micros) / 1e6);
}

/** cache_read ÷ (input_uncached + cache_read), as the Cost tab reads it. */
function cacheHitOf(tokens: RunTurnsResult["turns"][number]["tokens"]): string {
  if (tokens.inputUncached === null && tokens.cacheRead === null)
    return NOT_RECORDED;
  const read = tokens.cacheRead ?? 0;
  const total = read + (tokens.inputUncached ?? 0);
  return total === 0 ? NOT_RECORDED : `${Math.round((read / total) * 100)}%`;
}

/**
 * `oxagen run turns <run-id>`: every turn of one run, with its model and tool
 * steps, frames, cache hit, cost, and the cost so far. A figure the
 * record does not carry prints as not recorded, never as a zero.
 */
export async function runTurns(
  runId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunTurnsResult;
  try {
    result = await apiPostOrThrow<RunTurnsResult>("runs/turns", { runId });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  const last = result.turns.at(-1)?.cumulativeCost ?? null;
  writer.write(
    `${result.runId}: ${result.turns.length} turn(s), ${usdOf(last)} so far`,
  );
  if (result.turns.length === 0) {
    writer.write("The run has recorded no turn yet.");
    return;
  }
  const rows = [
    ["Turn", "Model", "Tool", "Frames", "Cache hit", "Cost", "So far"],
    ...result.turns.map((t) => [
      String(t.turn),
      String(t.modelSteps),
      String(t.toolSteps),
      String(t.frames),
      cacheHitOf(t.tokens),
      usdOf(t.cost),
      usdOf(t.cumulativeCost),
    ]),
  ];
  const widths = (rows[0] ?? []).map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? "").length)),
  );
  writer.write("");
  for (const r of rows) {
    writer.write(
      r
        .map((cell, col) =>
          col === 0
            ? cell.padEnd(widths[col] ?? 0)
            : cell.padStart(widths[col] ?? 0),
        )
        .join("  "),
    );
  }
  if (!result.complete) {
    writer.write("");
    writer.write(
      `The run is longer than one read carries. These are its first ${result.turns.length} turns.`,
    );
  }
}

/** Mirrors the `get_run` contract's pause, as far as the CLI prints it. */
interface RunShowPause {
  state: "pausing" | "paused" | "resuming";
  seq: string | null;
  turn: number | null;
  step: number | null;
  by: { id: string; name: string | null } | null;
  issuedAt: string;
  appliedAt: string | null;
  reason: string | null;
}

/** Mirrors the `get_run` contract output, as far as `oxagen run show` prints it. */
export interface RunShowResult {
  run: {
    id: string;
    name: string | null;
    agentKey: string | null;
    operatorId: string | null;
    operatorName: string | null;
    operatorAttribution: "initiator" | "host_enroller" | null;
    status: "live" | "sealed" | "halted";
    outcome: string;
    turns: number | null;
    steps: number;
    frames: number;
    cost: { micros: string; currency: string; basis: string } | null;
    costIsEstimate?: boolean;
    startedAt: string;
    sealedAt: string | null;
    replayGrade: string | null;
    enforcementTier: string;
    pause?: RunShowPause | null;
  };
  frames: {
    frames: {
      seq: string;
      observedAt: string;
      type: string;
      summary: string;
    }[];
    cursor: string | null;
  };
  framesError?: { code: string; message: string };
}

/** What a pause state still waits on, for the states that wait on something. */
const PAUSE_NOTES: Record<RunShowPause["state"], string | null> = {
  pausing: "It takes effect at the next boundary.",
  paused: null,
  resuming: "A resume is queued behind it.",
};

/**
 * Who the run names as its operator. A wrapped run names the person who
 * enrolled its host, which is not always the person at the keyboard, so it
 * says so.
 */
function operatorOf(run: RunShowResult["run"]): string {
  const who = run.operatorName ?? run.operatorId;
  if (who === null) return NOT_RECORDED;
  return run.operatorAttribution === "host_enroller"
    ? `${who} (enrolled the host)`
    : who;
}

/** The pause's lines, with every part the record does not hold left out. */
function pauseLines(pause: RunShowPause): string[] {
  const lines = [`Pause: ${pause.state}`];
  const note = PAUSE_NOTES[pause.state];
  if (note !== null) lines.push(`  ${note}`);
  const place = [
    ...(pause.turn === null ? [] : [`turn ${pause.turn}`]),
    ...(pause.step === null ? [] : [`step ${pause.step}`]),
  ];
  if (place.length > 0) lines.push(`  At: ${place.join(", ")}`);
  const by = pause.by === null ? NOT_RECORDED : (pause.by.name ?? pause.by.id);
  lines.push(`  Issued by: ${by} at ${pause.issuedAt}`);
  if (pause.appliedAt !== null) lines.push(`  Applied: ${pause.appliedAt}`);
  if (pause.reason !== null) lines.push(`  Reason: "${pause.reason}"`);
  if (pause.seq !== null) lines.push(`  Pause frame: seq ${pause.seq}`);
  return lines;
}

/**
 * `oxagen run show <run-id>`: one run's header and the first page of its
 * frames, from `get_run`. It prints the run's name, agent, status, outcome,
 * operator, tier, replay grade, times, counts and cost, one fact per line.
 * Then it prints the pause in force when there is one, and a line per frame.
 * A fact the record does not carry prints as not recorded, never as a zero.
 */
export async function runShow(
  runId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunShowResult;
  try {
    result = await apiPostOrThrow<RunShowResult>("runs/get", { runId });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  const { run } = result;
  writer.write(run.name === null ? run.id : `${run.id}: ${run.name}`);
  writer.write(`Agent: ${run.agentKey ?? NOT_RECORDED}`);
  writer.write(`Status: ${run.status}`);
  writer.write(`Outcome: ${run.outcome}`);
  writer.write(`Operator: ${operatorOf(run)}`);
  writer.write(`Tier: ${run.enforcementTier}`);
  writer.write(`Replay grade: ${run.replayGrade ?? NOT_RECORDED}`);
  writer.write(`Started: ${run.startedAt}`);
  writer.write(`Sealed: ${run.sealedAt ?? "not sealed"}`);
  writer.write(`Turns: ${run.turns ?? NOT_RECORDED}`);
  writer.write(`Steps: ${run.steps}`);
  writer.write(`Frames: ${run.frames}`);
  writer.write(
    `Cost: ${runCostOf(run.cost)}${run.cost !== null && run.costIsEstimate === true ? " (estimate)" : ""}`,
  );
  if (run.pause) for (const line of pauseLines(run.pause)) writer.write(line);

  writer.write("");
  const page = result.frames.frames;
  if (result.framesError) {
    writer.write(
      `The frames could not be read: ${result.framesError.message}`,
    );
  } else if (page.length === 0) {
    writer.write("The run has recorded no frame yet.");
  } else {
    const rows = [
      ["Seq", "Observed", "Type", "Summary"],
      ...page.map((f) => [f.seq, f.observedAt, f.type, f.summary]),
    ];
    const widths = (rows[0] ?? []).map((_, col) =>
      Math.max(...rows.map((r) => (r[col] ?? "").length)),
    );
    for (const r of rows) {
      writer.write(
        r
          .map((cell, col) =>
            col === r.length - 1 ? cell : cell.padEnd(widths[col] ?? 0),
          )
          .join("  "),
      );
    }
    if (run.frames > page.length) {
      writer.write("");
      writer.write(
        `The run holds ${run.frames} frames. These are its first ${page.length}.`,
      );
    }
  }
  writer.write("");
  writer.write(
    `Read its cost by turn with \`oxagen run turns ${run.id}\` and its chain with \`oxagen run chain ${run.id}\`.`,
  );
}

/**
 * One row of the `list_runs` output, as far as `oxagen run list` prints it.
 * The CLI talks to the API over HTTP and does not depend on @oxagen/oxagen,
 * so the shape is declared here (kept in sync with
 * packages/oxagen/src/contracts/run.list.ts).
 */
export interface RunListItem {
  id: string;
  agentKey: string | null;
  status: "live" | "sealed" | "halted";
  enforcementTier: string;
  cost: { micros: string; currency: string; basis: string } | null;
  startedAt: string;
}

/** The `list_runs` output, less the fields the table does not print. */
export interface RunListResult {
  runs: RunListItem[];
  nextCursor: string | null;
}

export interface RunListOptions {
  limit?: number;
  cursor?: string;
  json?: boolean;
}

/**
 * A run's cost as the table prints it: dollars for USD, the amount and its
 * currency otherwise, and "not recorded" when the run carries no cost. A
 * missing cost never prints as a zero.
 */
export function runCostOf(cost: RunListItem["cost"]): string {
  if (cost === null) return NOT_RECORDED;
  if (cost.currency.toUpperCase() === "USD") return usdOf(cost);
  return `${(Number(cost.micros) / 1e6).toFixed(2)} ${cost.currency}`;
}

/**
 * `oxagen run list`: the workspace's runs, newest first, one page at a time.
 * It posts to `/v1/{org}/{ws}/runs`, the route that serves `list_runs`, and
 * prints each run's id, agent, status, enforcement tier, cost, and start.
 * Pass `--cursor` with the value the last page printed to read the next one.
 */
export async function runList(
  opts: RunListOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunListResult;
  try {
    result = await apiPostOrThrow<RunListResult>("runs", {
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  if (result.runs.length === 0) {
    writer.write(
      opts.cursor === undefined
        ? "No runs in this workspace yet. A run appears when an enrolled agent makes its first model call. Enroll one with `oxagen agent enroll`."
        : "No more runs.",
    );
    return;
  }
  printTable(
    ["ID", "AGENT", "STATUS", "TIER", "COST", "STARTED"],
    result.runs.map((run) => [
      run.id,
      run.agentKey ?? NOT_RECORDED,
      run.status,
      run.enforcementTier,
      runCostOf(run.cost),
      run.startedAt,
    ]),
    writer,
  );
  if (result.nextCursor) {
    writer.write("");
    writer.write(
      `More runs: pass --cursor ${result.nextCursor} for the next page.`,
    );
  }
}

// ── oxagen run pause-all ─────────────────────────────────────────────────────

/** Mirrors the `pause_workspace_runs` contract output. */
export interface RunPauseAllResult {
  queued: number;
  commandIds: string[];
  skipped: {
    runId: string;
    agentKey: string;
    reason: "run_sealed" | "no_host" | "host_revoked" | "host_offline";
    commandId: string;
  }[];
}

/** Why a run was skipped, as the receipt prints it. */
const SKIP_REASONS: Record<
  RunPauseAllResult["skipped"][number]["reason"],
  string
> = {
  run_sealed: "the run has ended",
  no_host: "the run names no enrolled host",
  host_revoked: "the run's host was revoked",
  host_offline: "the run's host has not checked in for five minutes",
};

/**
 * `oxagen run pause-all --reason <text>`: `pause_workspace_runs`. Queues a
 * pause for every live wrapped run in the configured workspace as one
 * decision with one audit event, and prints how many runs took it, each run
 * that was skipped with why, and the command ids. Ledger runs (`arun_…`) are
 * not paused; pause one from its own row in the app or through the API.
 *
 * The API admits an org Owner or Admin, or the workspace Owner. A pause is
 * queued, not applied: each run stops at the next boundary its harness
 * reaches after its host collects the command.
 */
export async function runPauseAll(
  opts: { reason: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const reason = opts.reason.trim();
  if (reason === "") {
    out.error("Give a reason with --reason. Nothing was paused.", "reason");
    return;
  }
  let result: RunPauseAllResult;
  try {
    result = await apiPostOrThrow<RunPauseAllResult>(
      "commands/pause-workspace",
      { reason },
    );
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    result.queued === 1
      ? "Queued a pause for 1 live run."
      : `Queued a pause for ${result.queued} live runs.`,
  );
  if (result.skipped.length > 0) {
    writer.write(`Skipped ${result.skipped.length}, which no host can reach:`);
    for (const skip of result.skipped)
      writer.write(
        `  ${skip.runId} (${skip.agentKey}): ${SKIP_REASONS[skip.reason]}`,
      );
  }
  if (result.commandIds.length > 0)
    writer.write(`Command ids: ${result.commandIds.join(", ")}`);
  writer.write(
    "Ledger runs are not paused. Each run stops at its next boundary once its host collects the command.",
  );
}
