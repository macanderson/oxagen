/**
 * `oxagen context propose` — open the Context PR for a record proposal
 * (MC spec §14.1, ADR-061): the branch `context/<lineage>`, the single record
 * file, the pull request and the six checks, through `open_context_pr`.
 *
 *   oxagen context propose <proposalId> [--json]
 *   oxagen context propose --lineage <id> --kind <kind> --force <force>
 *                          --scope <workspace|repository> --statement "…"
 *                          --rationale "…" [--effect <require|forbid>] [--json]
 *
 * The second form records the proposal first (`propose_record`) and opens it.
 * Merge stays in Mission Control (`merge_context_pr`): the PR is the review.
 *
 * Output discipline (ADR-023 §4): `--json` emits the contract payload as one
 * line on stdout; pretty mode prints the PR, the state and each check;
 * failures are uniform stderr lines (exit 2 for a bad flag, exit 1 for an API
 * failure).
 */
import { apiPostOrThrow } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface ContextProposeOptions {
  proposalId?: string;
  lineage?: string;
  kind?: string;
  force?: string;
  scope?: string;
  statement?: string;
  rationale?: string;
  effect?: string;
  json?: boolean;
}

/** The parts of the `open_context_pr` output the pretty renderer prints. */
export interface ContextPrResult {
  proposalId: string;
  lineageId: string;
  status: string;
  governanceMode: string;
  pr: {
    number: number;
    url: string;
    repository: string;
    branch: string;
  } | null;
  checks: { name: string; status: string; summary: string }[];
  onMerge: {
    review: string;
    bundleVersion: { current: number; afterMerge: number };
  };
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
    "usage: oxagen context propose <proposalId> | --lineage <id> --kind <kind> --force <force> --scope <scope> --statement <text> --rationale <text> [--effect require|forbid]",
  );
  process.exitCode = 2;
}

export async function contextPropose(
  opts: ContextProposeOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let proposalId = opts.proposalId;

  if (!proposalId) {
    const missing = [
      "lineage",
      "kind",
      "force",
      "scope",
      "statement",
      "rationale",
    ].filter((k) => !opts[k as keyof ContextProposeOptions]);
    if (missing.length > 0) {
      return usage(
        writer,
        `a proposal id or --${missing.join(", --")} is required`,
      );
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
    try {
      const created = await apiPostOrThrow<{ proposalId: string }>(
        "context/proposals/create",
        {
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
        },
      );
      proposalId = created.proposalId;
      out.info(`Proposal ${proposalId} recorded.`);
    } catch (err) {
      out.error(err, "api");
      return;
    }
  }

  let result: ContextPrResult;
  try {
    result = await apiPostOrThrow<ContextPrResult>("context/prs/open", {
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
  renderContextPr(result, writer);
}

export function renderContextPr(
  r: ContextPrResult,
  writer: CommandWriter,
): void {
  const w = writer.write;
  w(`${r.lineageId} · ${r.proposalId} · ${r.status}`);
  if (r.pr)
    w(`${r.pr.repository}#${r.pr.number} on ${r.pr.branch} — ${r.pr.url}`);
  const passed = r.checks.filter((c) => c.status === "passed").length;
  w(`checks: ${passed} / ${r.checks.length}`);
  for (const c of r.checks)
    w(
      `  ${c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "·"} ${c.name}: ${c.summary}`,
    );
  w(`governance: ${r.governanceMode} — ${r.onMerge.review}`);
  w(
    r.status === "checks_passed"
      ? `merge from Mission Control publishes it as steering v${r.onMerge.bundleVersion.afterMerge}`
      : r.status === "checks_failed"
        ? "fix the failing checks on the branch and run `oxagen context propose <proposalId>` again"
        : `state: ${r.status}`,
  );
}
