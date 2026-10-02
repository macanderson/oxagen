/**
 * `oxagen steering promote <finding-id>`: turn one instruction-file statement
 * that contradicts a steering record into a proposal for that record
 * (promote_instruction_to_steering, #4518, ADR-253).
 *
 * The finding id (`crf_…`) comes from `oxagen steering findings`. The
 * proposal is a new version of the record, with the statement as its text and
 * the pull request and file line as its evidence. Its steering PR opens at
 * once and runs the six checks. Nothing steers until a person merges it.
 *
 * The API refuses a repeat, a statement that matches no record now, a
 * statement over 2,000 characters, a finding whose proposal is still open,
 * and a record with another PR open, and writes nothing.
 *
 * The call is POST `repository/findings/promote` on the org-scoped API,
 * through the shared client in lib/api.ts.
 *
 * Output discipline (ADR-023 §4): `--json` prints the contract's answer as
 * one line on stdout. A bad argument exits 2 before any request. A refusal or
 * an API failure prints on stderr and exits 1.
 */
import type { InstructionPromoteOutput } from "@oxagen/oxagen/contracts/repository.instruction.promote";
import { apiPostOrThrow } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";
import {
  PROPOSAL_STATUS_WORDS,
  reportApiFailure,
  usageError,
} from "./steering-findings.js";

/**
 * The capability `oxagen steering promote` calls, by its registered name.
 * The manifest's cli layer looks for the name in apps/cli/src/commands.
 */
export const STEERING_PROMOTE_CAPABILITIES = [
  "promote_instruction_to_steering",
] as const;

/** The shape of a finding id, as the contract checks it. */
const FINDING_ID = /^crf_[0-9A-Za-z]+$/;

const USAGE = "oxagen steering promote <finding-id> [--json]";

/** What to do next, for the refusals that leave the person something to do. */
const NEXT_STEPS: Readonly<Record<string, string>> = {
  finding_resolved:
    "Run `oxagen steering findings` to see the statements that still match a record.",
  already_proposed:
    "Run `oxagen steering findings` to see the open proposal and its steering PR.",
  lineage_pr_open:
    "Merge or close the PR that is open on the record, then promote the finding again.",
};

/**
 * `oxagen steering promote <finding-id> [--json]`: open a proposal from one
 * contradicting statement, and print the proposal id and its steering PR.
 */
export async function steeringPromote(
  findingId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const id = findingId.trim();
  if (!FINDING_ID.test(id)) {
    usageError(
      writer,
      `expected a finding id that starts with crf_, got ${JSON.stringify(findingId)}. Run \`oxagen steering findings\` to list them.`,
      USAGE,
    );
    return;
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: InstructionPromoteOutput;
  try {
    result = await apiPostOrThrow<InstructionPromoteOutput>(
      "repository/findings/promote",
      { finding_id: id },
    );
  } catch (err) {
    reportApiFailure(out, writer, err, NEXT_STEPS);
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(`Opened proposal ${result.proposal_id} for record ${result.lineage}.`);
  const pr = result.pull_request;
  writer.write(
    pr === null
      ? "Steering PR: none yet"
      : `Steering PR: #${pr.number} ${pr.url}`,
  );
  writer.write(`Status: ${PROPOSAL_STATUS_WORDS[result.status]}`);
  writer.write("Nothing steers until a person merges the steering PR.");
}
