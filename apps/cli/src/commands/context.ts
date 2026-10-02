/**
 * `oxagen context propose` — record a proposal on a lineage (MC spec §14.1,
 * ADR-061) through `propose_record`:
 *
 *   oxagen context propose --lineage <id> --kind <kind> --force <force>
 *                          --scope <workspace|repository> --statement "…"
 *                          --rationale "…" [--effect <require|forbid>] [--json]
 *
 * The steering PR is opened, checked and merged in Oxagen
 * (`open_steering_pr`, `merge_steering_pr`). Neither declares the `cli`
 * surface: merge_steering_pr needs a signed-in reviewer, which an API key is
 * not.
 *
 * `oxagen context revert` — open a steering PR that undoes a merged one
 * through `revert_steering_pr` (#4449):
 *
 *   oxagen context revert <proposalId> [--json]
 *
 * The handler acts for the API key's creator and applies the governance
 * mode's merge rule. The revert PR it opens merges after its own review.
 *
 * Output discipline (ADR-023 §4): `--json` emits the contract payload as one
 * line on stdout; pretty mode prints the proposal id and where it is opened;
 * failures are uniform stderr lines (exit 2 for a bad flag, exit 1 for an API
 * failure).
 */
import { apiPostOrThrow } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

interface ContextProposeOptions {
  lineage?: string;
  kind?: string;
  force?: string;
  scope?: string;
  statement?: string;
  rationale?: string;
  effect?: string;
  json?: boolean;
}

/** The `propose_record` output. */
export interface ProposalResult {
  proposalId: string;
  lineageId: string;
  status: string;
}

const KINDS = [
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
];
const FORCES = ["must", "should", "may", "info"];
const SCOPES = ["workspace", "repository"];
const EFFECTS = ["require", "forbid"];

function usage(writer: CommandWriter, message: string): void {
  writer.writeErr(`error: ${message}`);
  writer.writeErr(
    "usage: oxagen context propose --lineage <id> --kind <kind> --force <force> --scope <scope> --statement <text> --rationale <text> [--effect require|forbid]",
  );
  process.exitCode = 2;
}

export async function contextPropose(
  opts: ContextProposeOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const missing = [
    "lineage",
    "kind",
    "force",
    "scope",
    "statement",
    "rationale",
  ].filter((k) => !opts[k as keyof ContextProposeOptions]);
  if (missing.length > 0) {
    return usage(writer, `--${missing.join(", --")} is required`);
  }
  if (!KINDS.includes(opts.kind!))
    return usage(writer, `--kind is one of ${KINDS.join(", ")}`);
  if (!FORCES.includes(opts.force!))
    return usage(writer, `--force is one of ${FORCES.join(", ")}`);
  if (!SCOPES.includes(opts.scope!))
    return usage(writer, `--scope is one of ${SCOPES.join(", ")}`);
  if (opts.effect !== undefined && !EFFECTS.includes(opts.effect)) {
    return usage(writer, `--effect is one of ${EFFECTS.join(", ")}`);
  }
  if ((opts.kind === "constraint") !== (opts.effect !== undefined)) {
    return usage(writer, "a constraint takes --effect; no other kind does");
  }

  let result: ProposalResult;
  try {
    result = await apiPostOrThrow<ProposalResult>("context/proposals/create", {
      record: {
        lineageId: opts.lineage,
        kind: opts.kind,
        force: opts.force,
        sharingScope: opts.scope,
        statement: opts.statement,
        ...(opts.effect ? { constraintEffect: opts.effect } : {}),
      },
      rationale: opts.rationale,
      source: "oxagen context propose",
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(`${result.lineageId} · ${result.proposalId} · ${result.status}`);
  writer.write(
    "open its steering PR from Oxagen → Steering; merge there publishes it",
  );
}

interface ContextRevertOptions {
  json?: boolean;
}

/** The `revert_steering_pr` output. */
export interface RevertResult {
  proposalId: string;
  reverted: { number: number; mergedCommit: string };
  pullRequest: {
    number: number;
    url: string;
    branch: string;
    headSha: string | null;
  };
  check: "success" | "failure" | null;
}

const PROPOSAL_ID = /^prp_[0-9A-Za-z]+$/;

/** The line that says how the Oxagen steering check came out on the revert. */
function checkLine(check: RevertResult["check"]): string {
  if (check === "success") return "Oxagen steering check passed";
  if (check === "failure")
    return "Oxagen steering check failed: read the check on the pull request";
  return "no Oxagen steering check was reported";
}

export async function contextRevert(
  proposalId: string | undefined,
  opts: ContextRevertOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (!proposalId || !PROPOSAL_ID.test(proposalId)) {
    writer.writeErr("error: name the merged proposal, such as prp_01k5ru4a");
    writer.writeErr("usage: oxagen context revert <proposalId> [--json]");
    process.exitCode = 2;
    return;
  }
  let result: RevertResult;
  try {
    result = await apiPostOrThrow<RevertResult>("context/prs/revert", {
      proposalId,
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
    `opened #${result.pullRequest.number} on ${result.pullRequest.branch}: it reverts #${result.reverted.number}`,
  );
  writer.write(result.pullRequest.url);
  writer.write(checkLine(result.check));
}
