/**
 * `oxagen run export <run-id>` — CLI parity surface for `export_run`
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
