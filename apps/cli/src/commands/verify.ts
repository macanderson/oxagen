/**
 * `oxagen verify <bundle>`: check a run export bundle offline (Mission
 * Control spec §13.4, App. E; ADR-058).
 *
 * `<bundle>` is the zip `oxagen run download` wrote, or the directory it was
 * extracted to. The check is `verifyRunExport` from @oxagen/tacho: every
 * frame's digest and chain link, the Merkle root, each attempt's signed root
 * and Ed25519 signature, each ledger attempt's stream fold, and the redaction
 * summary against the frames.
 *
 * This module makes no network call and reads no CLI config. An auditor on a
 * clean machine runs it against a file and nothing else, so keep imports to
 * node:fs, fflate, @oxagen/tacho and the output seam.
 *
 * Output discipline (ADR-023 §4): `--json` prints the verification object as
 * one line; pretty mode prints one line per frame, then each bundle check,
 * then the redaction summary, then a HELD or BROKEN verdict. Anything broken
 * sets exit code 1.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  type FrameVerdict,
  type RedactionCount,
  type RunExportFiles,
  type RunExportVerification,
  verifyRunExport,
} from "@oxagen/tacho";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";

const REQUIRED = [
  "manifest.json",
  "frames.ndjson",
  "attestation.json",
] as const;
const OPTIONAL = "redactions.json";

/** A bundle that cannot be read, as distinct from one that reads as broken. */
class BundleReadError extends Error {}

function readDirectory(dir: string): RunExportFiles {
  const read = (name: string): string | undefined => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  return assemble(read, dir);
}

/**
 * A zip's entries by file name. A bundle someone re-zipped from its extracted
 * directory holds the same files one folder down, so an entry matches on its
 * last path segment when no top-level entry has the name.
 */
function readZip(path: string): RunExportFiles {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(readFileSync(path)));
  } catch (err) {
    throw new BundleReadError(
      `${path} is not a readable zip: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const decoder = new TextDecoder("utf-8");
  const read = (name: string): string | undefined => {
    const exact = entries[name];
    if (exact) return decoder.decode(exact);
    const nested = Object.keys(entries).find((key) => key.endsWith(`/${name}`));
    return nested ? decoder.decode(entries[nested]) : undefined;
  };
  return assemble(read, path);
}

function assemble(
  read: (name: string) => string | undefined,
  source: string,
): RunExportFiles {
  const missing = REQUIRED.filter((name) => read(name) === undefined);
  if (missing.length > 0) {
    throw new BundleReadError(
      `${source} is missing ${missing.join(", ")}. A run export bundle holds manifest.json, frames.ndjson and attestation.json.`,
    );
  }
  const redactions = read(OPTIONAL);
  return {
    "manifest.json": read("manifest.json") as string,
    "frames.ndjson": read("frames.ndjson") as string,
    "attestation.json": read("attestation.json") as string,
    ...(redactions === undefined ? {} : { "redactions.json": redactions }),
  };
}

/** Read a bundle from a zip file or an extracted directory. */
export function readBundle(path: string): RunExportFiles {
  if (!existsSync(path)) {
    throw new BundleReadError(`${path} does not exist.`);
  }
  return statSync(path).isDirectory() ? readDirectory(path) : readZip(path);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function digestLabel(state: FrameVerdict["digest"]): string {
  return state === "not_carried" ? "not carried" : state;
}

/** One line per frame: where it sits, its verdict, and why when broken. */
export function formatFrame(frame: FrameVerdict): string {
  const where =
    frame.attempt_id === ""
      ? "attempt none"
      : `attempt ${frame.attempt_id}${frame.seq === null ? "" : ` #${frame.seq}`}`;
  const parts = [
    `frame ${frame.line}`,
    where,
    frame.status,
    `digest ${digestLabel(frame.digest)}`,
    `link ${frame.link}`,
  ];
  if (frame.reasons.length > 0) parts.push(frame.reasons.join("; "));
  return parts.join("  ");
}

function formatCounts(counts: RedactionCount[]): string {
  return counts
    .map((c) => `${c.kind} ${c.count} (in ${plural(c.frames, "frame")})`)
    .join(", ");
}

/** The pretty report, as lines. Pure, so a test can read it whole. */
export function formatVerification(result: RunExportVerification): string[] {
  const lines: string[] = [];
  const runId = result.run_id ?? "unknown run";

  lines.push("Frames");
  if (result.frames.length === 0) lines.push("  The bundle holds no frames.");
  for (const frame of result.frames) lines.push(`  ${formatFrame(frame)}`);
  const notCarried = result.frames.filter(
    (f) => f.digest === "not_carried",
  ).length;
  if (notCarried > 0) {
    lines.push(
      `  Digest not carried on ${plural(notCarried, "wrapped (tse_) frame")}. A wrapped frame is hashed over its full event, and the bundle does not hold that event for these frames: an export before format 3 never did, and a format-3 export leaves it out when the stored row cannot be proven to rebuild it. For these frames, only the links and the Merkle root can be checked.`,
    );
  }

  lines.push("");
  lines.push("Checks");
  for (const check of result.checks) {
    lines.push(`  ${check.name}  ${check.status}  ${check.detail}`);
  }

  lines.push("");
  lines.push("Redactions");
  const r = result.redactions;
  if (r === null) {
    lines.push("  The bundle carries no redactions.json.");
  } else {
    lines.push(
      r.redacted.length === 0
        ? "  Redacted: none"
        : `  Redacted: ${formatCounts(r.redacted)}`,
    );
    lines.push(
      r.withheld.length === 0
        ? "  Withheld: none"
        : `  Withheld: ${formatCounts(r.withheld)}`,
    );
  }

  lines.push("");
  const brokenFrames = result.frames.filter(
    (f) => f.status === "broken",
  ).length;
  const brokenChecks = result.checks.filter(
    (c) => c.status === "broken",
  ).length;
  lines.push(
    result.ok
      ? `HELD ${runId}: ${plural(result.frames.length, "frame")}`
      : `BROKEN ${runId}: ${brokenFrames} of ${plural(result.frames.length, "frame")} broken, ${plural(brokenChecks, "check")} broken`,
  );
  return lines;
}

export async function verifyBundle(
  bundle: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunExportVerification;
  try {
    result = verifyRunExport(readBundle(bundle));
  } catch (err) {
    out.error(err, err instanceof BundleReadError ? "unreadable" : "verify");
    return;
  }
  if (out.isJson) out.data(result);
  else for (const line of formatVerification(result)) writer.write(line);
  if (!result.ok && (process.exitCode === undefined || process.exitCode === 0))
    process.exitCode = 1;
}
