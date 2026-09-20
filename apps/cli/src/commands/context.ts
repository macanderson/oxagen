/**
 * `oxagen context propose` — record a proposal on a lineage (MC spec §14.1,
 * ADR-061) through `propose_record`:
 *
 *   oxagen context propose --lineage <id> --kind <kind> --force <force>
 *                          --scope <workspace|repository> --statement "…"
 *                          --rationale "…" [--effect <require|forbid>] [--json]
 *
 * The Context PR is opened, checked and merged in Oxagen
 * (`open_context_pr`, `merge_context_pr`): both gate on the caller's org or
 * workspace role and declare only the `api` surface.
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
    "open its Context PR from Oxagen → Steering; merge there publishes it",
  );
}
