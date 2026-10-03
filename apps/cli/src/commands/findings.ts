/**
 * `oxagen findings list [--run <id>] [--status <status>] [--level <level>]
 * [--subject <key>] [--kind <kind>] [--cursor <cursor>]`: the CLI parity surface for
 * `list_findings` (ADR-062, #4001). It prints the workspace's costed
 * findings, largest saving first, with the total saving and its annualised
 * figure. With `--run`, it lists only the findings that cite that run, and
 * each one names the frames it cites there. With `--level` and `--subject`,
 * it lists only the findings about one agent, operator, tool or workspace,
 * and with `--kind` only the findings of one kind. The API names a kind it
 * does not know in its refusal, so the command keeps no list of kinds.
 * The API lists at most 50 findings a page, and the count and totals cover
 * every one (#5262). When more findings follow, a line under the table says
 * which ones the page shows and gives the `--cursor` that prints the next
 * page (#5303).
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

const LEVELS = ["tool", "agent", "operator", "workspace"] as const;
type FindingLevel = (typeof LEVELS)[number];

/** The longest cursor and subject the API accepts. */
const CURSOR_MAX = 256;
const SUBJECT_MAX = 256;

/** How many cited frames a row names before it counts the rest. */
const FRAMES_SHOWN = 5;

type Money = { micros: string; currency: string };

/** Mirrors the `list_findings` contract output, as far as this command reads it. */
export interface FindingListResult {
  status: FindingStatus;
  saving: (Money & { basis: string }) | null;
  annualised: (Money & { basis: string }) | null;
  counts: { findings: number; high: number; medium: number; operators: number };
  /** True when the workspace holds more findings than the list; absent from an older API. */
  truncated?: boolean;
  /** The cursor that reads the next page; null on the last page, absent from an older API. */
  nextCursor?: string | null;
  /** How many findings come before this page; absent from an older API. */
  offset?: number;
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

function isLevel(value: string): value is FindingLevel {
  return (LEVELS as readonly string[]).includes(value);
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
  opts: {
    run?: string;
    status?: string;
    level?: string;
    subject?: string;
    kind?: string;
    cursor?: string;
    json?: boolean;
  },
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
  if (opts.level !== undefined && !isLevel(opts.level)) {
    process.exitCode = 2;
    out.error(
      `Invalid --level "${opts.level}". Use tool, agent, operator or workspace.`,
      "usage",
    );
    return;
  }
  if (
    opts.subject !== undefined &&
    (opts.subject.length === 0 || opts.subject.length > SUBJECT_MAX)
  ) {
    process.exitCode = 2;
    out.error(
      `Invalid --subject. Provide an agent key, an operator id, a tool name or the workspace id, at most ${SUBJECT_MAX} characters.`,
      "usage",
    );
    return;
  }
  if (opts.kind !== undefined && !/^[a-z_]+$/.test(opts.kind)) {
    process.exitCode = 2;
    out.error(
      `Invalid --kind "${opts.kind}". Provide a finding kind, such as retry_loops.`,
      "usage",
    );
    return;
  }
  if (
    opts.cursor !== undefined &&
    (opts.cursor.length === 0 || opts.cursor.length > CURSOR_MAX)
  ) {
    process.exitCode = 2;
    out.error(
      "Invalid --cursor. Copy the cursor the previous page printed.",
      "usage",
    );
    return;
  }
  let result: FindingListResult;
  try {
    result = await apiPostOrThrow<FindingListResult>("spend/findings", {
      status,
      ...(opts.run === undefined ? {} : { runId: opts.run }),
      ...(opts.level === undefined ? {} : { level: opts.level }),
      ...(opts.subject === undefined ? {} : { subject: opts.subject }),
      ...(opts.kind === undefined ? {} : { kind: opts.kind }),
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
  const scope = [
    opts.kind === undefined ? "" : ` of kind ${opts.kind}`,
    opts.run === undefined ? "" : ` citing ${opts.run}`,
    opts.subject === undefined ? "" : ` about ${opts.subject}`,
  ].join("");
  if (result.findings.length === 0) {
    writer.write(
      opts.cursor === undefined
        ? `No ${status} findings${scope}.`
        : `No more ${status} findings${scope}.`,
    );
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
  if (result.truncated === true) {
    const first = (result.offset ?? 0) + 1;
    const last = first + result.findings.length - 1;
    writer.write("");
    writer.write(
      `The list shows findings ${first} to ${last} of ${result.counts.findings} ${status} findings.`,
    );
    if (typeof result.nextCursor === "string")
      writer.write(
        `Run the command again with --cursor ${result.nextCursor} to list the next page.`,
      );
  }
}
