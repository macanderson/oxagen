/** `oxagen run evidence …` — the narrow, governed RunEvidenceManifestV1 ingestion
 *  + read surface (docs/specs/workspace-graph-boundary/spec.md).
 *
 *    oxagen run evidence submit --file <manifest.json>
 *    oxagen run evidence list [--run-id <id>] [--repository-id <uuid>]
 *
 *  `submit` reads a manifest JSON file and POSTs it to the org-scoped
 *  `/run/evidence` API, which validates it against the contract and stamps it
 *  `client_attested` server-side. `list` reads back manifest summaries.
 *
 *  Output follows the universal discipline: `--json` (or piped stdout) emits one
 *  machine JSON line; a TTY prints a human view. */
import { readFileSync } from "fs";
import { apiGetOrThrow, apiPostOrThrow, printTable } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";

interface RunEvidenceSubmitResult {
  manifestId: string;
  manifestDigest: string;
  deduplicated: boolean;
}

interface RunEvidenceManifestSummary {
  id: string;
  runId: string;
  attemptId: string | null;
  evidenceAuthority: string;
  manifestDigest: string;
  createdAt: string;
  changeCount: number;
  frameCount: number;
}

interface RunEvidenceListResult {
  manifests: RunEvidenceManifestSummary[];
  nextCursor: string | null;
}

export interface RunEvidenceSubmitOptions {
  file: string;
  json?: boolean;
  quiet?: boolean;
}

export async function handleRunEvidenceSubmit(
  opts: RunEvidenceSubmitOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput(
    { json: opts.json, quiet: opts.quiet, autoJson: true },
    writer,
  );

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(opts.file, "utf8"));
  } catch (err) {
    cmd.error(err, "invalid_manifest_file");
    return;
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    cmd.error(
      new Error(`--file ${opts.file} must contain a JSON manifest object`),
      "invalid_manifest_file",
    );
    return;
  }

  let result: RunEvidenceSubmitResult;
  try {
    result = await apiPostOrThrow<RunEvidenceSubmitResult>(
      "run/evidence",
      manifest,
    );
  } catch (err) {
    cmd.error(err);
    return;
  }

  cmd.data(result, (r) =>
    r.deduplicated
      ? `Evidence already recorded (deduplicated): ${r.manifestId}`
      : `Submitted evidence manifest ${r.manifestId} (digest ${r.manifestDigest.slice(0, 12)}…)`,
  );
}

export interface RunEvidenceListOptions {
  runId?: string;
  repositoryId?: string;
  limit?: string;
  cursor?: string;
  json?: boolean;
  quiet?: boolean;
}

export async function handleRunEvidenceList(
  opts: RunEvidenceListOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput(
    { json: opts.json, quiet: opts.quiet, autoJson: true },
    writer,
  );

  let result: RunEvidenceListResult;
  try {
    result = await apiGetOrThrow<RunEvidenceListResult>("run/evidence", {
      runId: opts.runId,
      repositoryId: opts.repositoryId,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      cursor: opts.cursor,
    });
  } catch (err) {
    cmd.error(err);
    return;
  }

  if (cmd.isJson) {
    cmd.data(result);
    return;
  }

  printTable(
    ["MANIFEST", "RUN", "ATTEMPT", "AUTHORITY", "CHANGES", "FRAMES", "CREATED"],
    result.manifests.map((m) => [
      m.id,
      m.runId,
      m.attemptId ?? "-",
      m.evidenceAuthority,
      String(m.changeCount),
      String(m.frameCount),
      m.createdAt,
    ]),
    writer,
  );
  if (result.nextCursor) {
    cmd.info(`More results — re-run with --cursor ${result.nextCursor}`);
  }
}
