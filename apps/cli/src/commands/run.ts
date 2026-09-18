/**
 * `oxagen run export <run-id>` and `oxagen run chain <run-id>` — the CLI
 * parity surfaces for `export_run` and `get_run_chain`
 * (Mission Control spec §14.1; ADR-058).
 *
 * Queues the signed, offline-verifiable evidence bundle for one sealed run
 * and prints the export id the job was queued under. The bundle is built off
 * the request path; Audit › exports lists the job and, once it is ready,
 * where the bundle landed.
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload
 * as one line on stdout; pretty mode prints the id and what to do next;
 * failures are uniform stderr error lines (exit 1 for an API failure).
 */
import { apiPostOrThrow } from "../lib/api.js";
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
    "The bundle (frames as NDJSON, Merkle root, attestation, verifying key and verifier script) is listed under Audit › exports once it is built.",
  );
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
  seal: { sealedAt: string; terminalStatus: string } | null;
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
  writer.write(`${result.runId} — ${result.frameCount} frames, ${result.hashRule}`);
  writer.write(`Merkle root: ${result.merkleRoot ?? "not recorded"}`);
  writer.write(
    `Observed at: ${result.enforcementTier} · recorded grade: ${result.recordedGrade ?? "not recorded"}`,
  );
  writer.write("");
  writer.write("Replay ladder");
  for (const rung of result.ladder) {
    writer.write(`  ${rung.met ? "✓" : "·"} ${rung.grade} — ${rung.reason}`);
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
        gaps.recorded.length > 0 ? `, recorded: ${gaps.recorded.join(", ")}` : ""
      }`,
    );
    for (const gap of gaps.missingSequences) {
      writer.write(`  sequences ${gap.from}–${gap.to}`);
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
