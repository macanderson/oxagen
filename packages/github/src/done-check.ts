// done-check.ts: the "Oxagen done" check run on a pull request's head commit.
//
// agent-work-spec.html (Done record): each verdict change posts this check. A
// proven record is success, a held record is neutral, a broken record is
// failure, and a pending record is a run still in progress. GitHub passes a
// required check on neutral, so a held record, which is done, never blocks a
// merge that requires the check.
//
// The check shows the signed statement, not the done record, so it says what
// the attestation says. It shows criterion ids and states, reason codes with
// Oxagen's own messages, and digests. It never shows a criterion's text, so
// outside text from an issue never reaches the check.
//
// Each post creates a new run. When several runs share a name on one commit,
// GitHub reports the latest.
import {
  DONE_CHECK_NAME,
  DONE_REASONS,
  envelopeCarries,
  type DoneAttestation,
  type DoneStatement,
  type DoneVerdict,
} from "@oxagen/done-record/attestation";
import type { GitHubCheckRunArgs, GitHubCheckRunConclusion, GitHubClient } from "./types";

/** GitHub's limit on each check run output field, in characters. */
export const CHECK_OUTPUT_MAX = 65_535;

/** What a verdict posts: a completed run with a conclusion, or a run in progress. */
export type DoneCheckStatus =
  | { status: "completed"; conclusion: GitHubCheckRunConclusion }
  | { status: "in_progress" };

const STATUS: Readonly<Record<DoneVerdict, DoneCheckStatus>> = {
  proven: { status: "completed", conclusion: "success" },
  held: { status: "completed", conclusion: "neutral" },
  broken: { status: "completed", conclusion: "failure" },
  pending: { status: "in_progress" },
};

const TITLE: Readonly<Record<DoneVerdict, string>> = {
  proven: "Proven",
  held: "Held",
  broken: "Broken",
  pending: "Pending",
};

const LEAD: Readonly<Record<DoneVerdict, string>> = {
  proven:
    "The done record is proven. Every criterion with an oracle passed it in a contained verify stage, and the rest are held.",
  held: "The done record is held. Every criterion is held or proven, so the work item is done.",
  broken: "The done record is broken. The reasons below say why.",
  pending:
    "The done record is pending. A criterion is still open, or a person's signature is outstanding.",
};

const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CRITERION_ID = /^[a-z0-9-]{1,40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const CUT_NOTE = "\n\nThe rest is cut to fit GitHub's limit.";

function fail(message: string): never {
  throw new TypeError(`done check: ${message}`);
}

/** The check run status and conclusion for a verdict. */
export function doneCheckStatus(verdict: DoneVerdict): DoneCheckStatus {
  if (!Object.hasOwn(STATUS, verdict)) fail(`unknown verdict ${String(verdict)}`);
  return STATUS[verdict];
}

/** Everything the check needs for one verdict change. */
export interface DoneCheckInput {
  owner: string;
  repo: string;
  /** The statement to show, from doneStatement. Its subject commit is the head commit. */
  statement: DoneStatement;
  /** The signed envelope of the same statement. Absent when no signing key is set. */
  attestation?: DoneAttestation;
  /** The work item's page in Oxagen. */
  detailsUrl?: string;
  /** The badge image, from doneBadgeUrl. */
  badgeUrl?: string;
  /** The published public key document, so a reader can check the envelope. */
  keyUrl?: string;
}

function httpsUrl(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`${what} must be an https URL`);
  }
  if (url.protocol !== "https:") fail(`${what} must be an https URL`);
  return url.href;
}

function criterionId(id: string): string {
  if (!CRITERION_ID.test(id)) fail(`criterion id ${JSON.stringify(id)} is not a criterion id`);
  return id;
}

function fit(text: string): string {
  if (text.length <= CHECK_OUTPUT_MAX) return text;
  return text.slice(0, CHECK_OUTPUT_MAX - CUT_NOTE.length) + CUT_NOTE;
}

function digest(value: string, what: string): string {
  if (!DIGEST.test(value)) fail(`${what} must be a sha256 digest`);
  return value;
}

function summary(
  input: DoneCheckInput,
  keyUrl: string | undefined,
  badgeUrl: string | undefined,
): string {
  const { predicate } = input.statement;
  const lines = [LEAD[predicate.verdict]];

  if (predicate.criteria.length > 0) {
    lines.push("", "| Criterion | State |", "| --- | --- |");
    for (const c of predicate.criteria) lines.push(`| \`${criterionId(c.id)}\` | ${c.state} |`);
  }

  if (predicate.reasons.length > 0) {
    lines.push("", "Reasons:", "");
    for (const r of predicate.reasons) {
      if (!Object.hasOwn(DONE_REASONS, r.code)) fail(`unknown reason code ${JSON.stringify(r.code)}`);
      const about = r.criterion === undefined ? "" : ` (\`${criterionId(r.criterion)}\`)`;
      lines.push(`- \`${r.code}\`${about}: ${DONE_REASONS[r.code]}`);
    }
  }

  lines.push("", `Done record: \`${digest(predicate.record_digest, "record_digest")}\``);
  if (input.attestation) {
    const ref = digest(input.attestation.ref, "the attestation ref");
    const keyid = input.attestation.envelope.signatures[0]?.keyid ?? "";
    const signer = KEY_ID.test(keyid) ? `, signed with key \`${keyid}\`` : "";
    lines.push(`Attestation: \`${ref}\`${signer}`);
    if (keyUrl) lines.push(`Public key: ${keyUrl}`);
  }
  if (badgeUrl) lines.push("", `![Oxagen done: ${predicate.verdict}](${badgeUrl})`);
  return fit(lines.join("\n"));
}

function envelopeText(attestation: DoneAttestation): string {
  const text = [
    "The signed envelope (DSSE, in-toto Statement v1). Check it with the published public key.",
    "",
    "```json",
    JSON.stringify(attestation.envelope, null, 2),
    "```",
  ].join("\n");
  if (text.length <= CHECK_OUTPUT_MAX) return text;
  return `The signed envelope is longer than GitHub allows here. Its digest is \`${attestation.ref}\`.`;
}

/**
 * The check run for one verdict change. Throws a TypeError when the statement's
 * commit or ids are malformed, when a URL is not https, or when the attestation
 * carries a different statement.
 */
export function doneCheckRun(input: DoneCheckInput): GitHubCheckRunArgs {
  const { statement } = input;
  const { verdict, decided_at: decidedAt, record_digest: recordDigest } = statement.predicate;
  const status = doneCheckStatus(verdict);
  const headSha = statement.subject[0].digest.gitCommit;
  if (!COMMIT_SHA.test(headSha)) fail("the statement's commit must be a lowercase hex SHA");
  if (input.attestation && !envelopeCarries(input.attestation.envelope, statement)) {
    fail("the attestation carries a different statement");
  }
  const detailsUrl = httpsUrl(input.detailsUrl, "detailsUrl");
  const badgeUrl = httpsUrl(input.badgeUrl, "badgeUrl");
  const keyUrl = httpsUrl(input.keyUrl, "keyUrl");

  const base = {
    owner: input.owner,
    repo: input.repo,
    name: DONE_CHECK_NAME,
    headSha,
    title: TITLE[verdict],
    summary: summary(input, keyUrl, badgeUrl),
    ...(input.attestation ? { text: envelopeText(input.attestation) } : {}),
    ...(detailsUrl ? { detailsUrl } : {}),
    externalId: recordDigest,
    startedAt: decidedAt,
  };
  return status.status === "in_progress"
    ? { ...base, status: "in_progress" }
    : { ...base, status: "completed", conclusion: status.conclusion, completedAt: decidedAt };
}

/** Post the check for one verdict change and return the run's page. */
export async function postDoneCheck(
  client: Pick<GitHubClient, "createCheckRun">,
  input: DoneCheckInput,
): Promise<{ id: number; htmlUrl: string }> {
  return client.createCheckRun(doneCheckRun(input));
}
