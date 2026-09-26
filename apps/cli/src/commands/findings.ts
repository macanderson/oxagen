/**
 * `oxagen findings list [--run <id>] [--status <status>]`: the CLI parity
 * surface for `list_findings` (ADR-062, #4001). It prints the workspace's
 * costed findings, largest saving first, with the total saving and its
 * annualised figure. With `--run`, it lists only the findings that cite that
 * run, and each one names the frames it cites there.
 *
 * The call goes through the shared org-scoped API client in lib/api.ts
 * (POST /spend/findings). Output discipline (ADR-023 §4): `--json` emits the
 * contract payload as one line on stdout, pretty mode renders a table, and a
 * failure is a stderr error line (exit 2 for a bad flag, exit 1 for an API
 * failure).
 */
import { formatUsd } from "@oxagen/billing/rate-card";
import { apiPostOrThrow, printTable } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";

const STATUSES = ["open", "applied", "dismissed"] as const;
type FindingStatus = (typeof STATUSES)[number];

/** How many cited frames a row names before it counts the rest. */
const FRAMES_SHOWN = 5;

type Money = { micros: string; currency: string };

/** Mirrors the `list_findings` contract output, as far as this command reads it. */
export interface FindingListResult {
  status: FindingStatus;
  saving: (Money & { basis: string }) | null;
  annualised: (Money & { basis: string }) | null;
  counts: { findings: number; high: number; medium: number; operators: number };
  findings: {
    id: string;
    kind: string;
    subject: string;
    saving: Money & { basis: string };
    confidence: "high" | "medium";
    runs: number;
    calls: number;
    citation?: {
      runId: string;
      runLevel: boolean;
      frames: { seq: string; sessionUuid?: string }[] | null;
      framesTotal: number | null;
    };
  }[];
}

function isStatus(value: string): value is FindingStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/** A run's public id, as the contract accepts it. */
function isRunId(value: string): boolean {
  return /^(arun|tse)_[0-9a-z]+$/.test(value);
}

function usdOf(cost: Money | null): string {
  return cost === null ? "not recorded" : formatUsd(Number(cost.micros) / 1e6);
}

/** What a finding cites in the run, in a few words. */
function citedOf(
  citation: NonNullable<FindingListResult["findings"][number]["citation"]>,
): string {
  if (citation.runLevel) return "the whole run";
  if (citation.frames === null) return "not recorded";
  const shown = citation.frames
    .slice(0, FRAMES_SHOWN)
    .map((f) =>
      f.sessionUuid === undefined
        ? `#${f.seq}`
        : `#${f.seq} (subagent ${f.sessionUuid.slice(0, 8)})`,
    );
  const more = (citation.framesTotal ?? shown.length) - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export async function findingsList(
  opts: { run?: string; status?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const status = opts.status ?? "open";
  if (!isStatus(status)) {
    process.exitCode = 2;
    out.error(
      `Invalid --status "${status}". Use open, applied or dismissed.`,
      "usage",
    );
    return;
  }
  if (opts.run !== undefined && !isRunId(opts.run)) {
    process.exitCode = 2;
    out.error(
      `Invalid --run "${opts.run}". Provide a run id (arun_… or tse_…).`,
      "usage",
    );
    return;
  }
  let result: FindingListResult;
  try {
    result = await apiPostOrThrow<FindingListResult>("spend/findings", {
      status,
      ...(opts.run === undefined ? {} : { runId: opts.run }),
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  const scope = opts.run === undefined ? "" : ` citing ${opts.run}`;
  if (result.findings.length === 0) {
    writer.write(`No ${status} findings${scope}.`);
    return;
  }
  writer.write(
    `${result.counts.findings} ${status} finding(s)${scope}: ${usdOf(result.saving)} to save, ${usdOf(result.annualised)} a year`,
  );
  writer.write("");
  const cited = opts.run !== undefined;
  printTable(
    [
      "Finding",
      "Kind",
      "Subject",
      "Saving",
      "Confidence",
      cited ? "Cited" : "Runs",
    ],
    result.findings.map((f) => [
      f.id,
      f.kind,
      f.subject,
      usdOf(f.saving),
      f.confidence,
      cited && f.citation !== undefined ? citedOf(f.citation) : String(f.runs),
    ]),
    writer,
  );
}
