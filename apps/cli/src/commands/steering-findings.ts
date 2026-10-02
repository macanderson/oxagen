/**
 * `oxagen steering findings`: the statements in the instruction files of the
 * workspace's linked code repositories that repeat or contradict a steering
 * record (list_code_repository_findings, #4518, ADR-253).
 *
 * The Oxagen check on a linked repository's pull requests stores each
 * statement it flags. The read compares them with today's records, so a
 * statement that matches no record now is left out. Each finding has an id
 * (`crf_…`) that `oxagen steering promote` takes.
 *
 * The call is GET `repository/findings` on the org-scoped API, through the
 * shared client in lib/api.ts.
 *
 * This file also holds what `oxagen steering promote` and
 * `oxagen steering restore-block` share with it: how an API refusal is read
 * and printed, and the plain words for a proposal's status.
 *
 * Output discipline (ADR-023 §4): `--json` prints the contract's answer as
 * one line on stdout. A failure prints one line on stderr and exits 1.
 */
import type { ProposalStatus } from "@oxagen/oxagen/contracts/context.steering.shared";
import type {
  CodeRepositoryFinding,
  CodeRepositoryFindingsListOutput,
} from "@oxagen/oxagen/contracts/repository.findings.list";
import { apiGetOrThrow, printTable } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput, errorMessage, type Output } from "../lib/output.js";

/**
 * The capability `oxagen steering findings` calls, by its registered name.
 * The manifest's cli layer looks for the name in apps/cli/src/commands.
 */
export const STEERING_FINDINGS_CAPABILITIES = [
  "list_code_repository_findings",
] as const;

// ── Shared with promote and restore-block ────────────────────────────────────

/** A refusal the API sent back: its code, its reason when it gave one, and its message. */
export interface ApiRefusal {
  code: string | null;
  reason: string | null;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The refusal an API failure carries. The client puts the response body in
 * the error's message, after `Error <status> from <path>: `, and may add a
 * trace id after it. So the body is read from the first `{` to the last `}`.
 * A failure with no JSON body, such as a network error, keeps its whole
 * message and has no code or reason.
 */
export function apiRefusal(err: unknown): ApiRefusal {
  const message = errorMessage(err);
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const body: unknown = JSON.parse(message.slice(start, end + 1));
      const error = isRecord(body) && isRecord(body.error) ? body.error : null;
      const said = error === null ? null : textOrNull(error.message);
      if (error !== null && said !== null) {
        return {
          code: textOrNull(error.code),
          reason: textOrNull(error.reason),
          message: said,
        };
      }
    } catch {
      // The text between the braces is not JSON. Keep the message as it is.
    }
  }
  return { code: null, reason: null, message };
}

/**
 * Print an API failure and exit 1. The line carries the API's own message.
 * With `--json`, the error line's code is the refusal's reason, such as
 * `block_intact`, so a script can act on it. In pretty mode, a reason listed
 * in `nextSteps` adds a second line that says what to do.
 */
export function reportApiFailure(
  out: Output,
  writer: CommandWriter,
  err: unknown,
  nextSteps: Readonly<Record<string, string>> = {},
): void {
  const refusal = apiRefusal(err);
  out.error(refusal.message, refusal.reason ?? refusal.code ?? "api");
  if (out.isJson || refusal.reason === null) return;
  const next = nextSteps[refusal.reason];
  if (next !== undefined) writer.writeErr(next);
}

/** A proposal's status in plain words. */
export const PROPOSAL_STATUS_WORDS: Readonly<Record<ProposalStatus, string>> = {
  proposed: "waiting for its steering PR",
  pr_open: "steering PR open",
  checks_running: "checks running",
  checks_passed: "checks passed",
  checks_failed: "checks failed",
  merged: "merged",
  rejected: "rejected",
};

/** Print a bad argument and exit 2, before any request leaves the process. */
export function usageError(
  writer: CommandWriter,
  message: string,
  line: string,
): void {
  writer.writeErr(`error: ${message}`);
  writer.writeErr(`usage: ${line}`);
  process.exitCode = 2;
}

// ── steering findings ────────────────────────────────────────────────────────

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One table row: id, kind, file and line, record, pull request, and proposal. */
function findingRow(finding: CodeRepositoryFinding): string[] {
  const pr = finding.pull_request;
  const proposal = finding.proposal;
  return [
    finding.id,
    finding.kind,
    `${finding.path}:${finding.line}`,
    finding.record.label ?? finding.record.lineage,
    `#${pr.number} ${pr.state}`,
    proposal === null
      ? "none"
      : `${proposal.id} (${PROPOSAL_STATUS_WORDS[proposal.status]})`,
  ];
}

/**
 * `oxagen steering findings [--json]`: list the findings, grouped by
 * repository, one row per finding. A repository with no finding is left out
 * of the table.
 */
export async function steeringFindings(
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: CodeRepositoryFindingsListOutput;
  try {
    result = await apiGetOrThrow<CodeRepositoryFindingsListOutput>(
      "repository/findings",
    );
  } catch (err) {
    reportApiFailure(out, writer, err);
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  const repositories = result.repositories.filter((r) => r.findings.length > 0);
  if (repositories.length === 0) {
    writer.write(
      "No findings. The Oxagen check found no statement in a linked repository's instruction files that repeats or contradicts a steering record.",
    );
    return;
  }
  let total = 0;
  for (const [index, repository] of repositories.entries()) {
    if (index > 0) writer.write("");
    writer.write(`${repository.full_name} (${repository.provider})`);
    printTable(
      ["FINDING", "KIND", "FILE", "RECORD", "PULL REQUEST", "PROPOSAL"],
      repository.findings.map(findingRow),
      writer,
    );
    total += repository.findings.length;
  }
  writer.write("");
  writer.write(
    `${plural(total, "finding", "findings")} in ${plural(repositories.length, "repository", "repositories")}.`,
  );
  const promotable = repositories.some((r) =>
    r.findings.some((f) => f.kind === "contradiction" && f.proposal === null),
  );
  if (promotable) {
    writer.write(
      "Promote a contradiction to a proposal with `oxagen steering promote <finding-id>`.",
    );
  }
}
