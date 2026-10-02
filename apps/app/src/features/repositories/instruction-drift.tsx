"use client";
// The statements a code repository's instruction files hold that repeat or
// contradict a steering record (#4518, ADR-263). Each finding names the file
// and line, quotes the statement, names the record, and links the pull
// request that added it. A contradiction offers Promote to steering, which
// proposes the line as the record's new text through
// `promote_instruction_to_steering` and opens its steering PR, so nothing
// steers from the line until that PR merges. A repeat offers nothing to
// promote: steering already says it. With no findings the list draws nothing.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { buttonSecondary, linkText } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { PullRequestLink } from "@/ui/navigation";
import { promoteInstructionToSteering } from "./actions";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { code, note } from "./parts";

const PROMOTE_CAPABILITY = "promote_instruction_to_steering";

/** One statement that repeats or contradicts a steering record. */
export type InstructionDriftFinding = {
  /** The finding's id (`crf_…`), which Promote to steering sends. */
  id: string;
  /** The instruction file's path in the repository, such as `AGENTS.md`. */
  path: string;
  line: number;
  statement: string;
  kind: "repeat" | "contradiction";
  /** The record's label, or its lineage when it has none. */
  record: string;
  pullRequest: { number: number; url: string; merged: boolean };
  /** The proposal a promote opened that is still in flight, or null. */
  proposalId: string | null;
};

export function InstructionDriftWarning({
  org,
  ws,
  findings,
}: {
  org: string;
  ws: string;
  findings: readonly InstructionDriftFinding[];
}) {
  if (findings.length === 0) return null;
  return (
    <ul data-testid="instruction-drift" className="flex flex-col gap-2">
      {findings.map((finding) => (
        <DriftFinding key={finding.id} org={org} ws={ws} finding={finding} />
      ))}
    </ul>
  );
}

function PullRequest({ pullRequest }: { pullRequest: InstructionDriftFinding["pullRequest"] }) {
  const t = useTranslations("repositories.drift");
  const label = pullRequest.merged
    ? t("mergedPullRequest", { number: pullRequest.number })
    : t("openPullRequest", { number: pullRequest.number });
  const url = parsePullRequestUrl(pullRequest.url);
  return url === null ? (
    <span className="text-xs text-muted-foreground">{label}</span>
  ) : (
    <PullRequestLink to={url} className={`${linkText} text-xs`}>
      {label}
    </PullRequestLink>
  );
}

function DriftFinding({
  org,
  ws,
  finding,
}: {
  org: string;
  ws: string;
  finding: InstructionDriftFinding;
}) {
  const t = useTranslations("repositories.drift");
  const failureText = useRepositoriesFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);

  async function promote() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await promoteInstructionToSteering(org, ws, finding.id);
      if (result.ok) setProposalId(result.value.proposalId);
      else setFailure(failureText(result, PROMOTE_CAPABILITY));
    } catch {
      setFailure(failureText(UNANSWERED, PROMOTE_CAPABILITY));
    } finally {
      setPending(false);
    }
  }

  const promotable =
    finding.kind === "contradiction" && finding.proposalId === null && proposalId === null;
  return (
    <li
      data-testid="instruction-drift-finding"
      data-finding={finding.id}
      data-path={finding.path}
      data-kind={finding.kind}
      className={`${note} flex flex-col items-start gap-2 border-info`}
    >
      <p className="text-foreground">
        {t.rich("location", { path: finding.path, line: finding.line, code })}
      </p>
      <blockquote className="border-l-2 border-border pl-3 text-foreground">
        {finding.statement}
      </blockquote>
      <p>
        {finding.kind === "contradiction"
          ? t("contradiction", { record: finding.record })
          : t("repeat", { record: finding.record })}
      </p>
      <PullRequest pullRequest={finding.pullRequest} />
      {promotable ? (
        <button
          type="button"
          data-testid="instruction-drift-promote"
          data-touch-target=""
          disabled={pending}
          className={buttonSecondary}
          onClick={() => {
            void promote();
          }}
        >
          {pending ? t("promoting") : t("promote")}
        </button>
      ) : null}
      {proposalId !== null ? (
        <p role="status" data-testid="instruction-drift-promoted">
          {t("promoted", { proposalId })}
        </p>
      ) : finding.proposalId !== null ? (
        <p data-testid="instruction-drift-proposed">
          {t("proposed", { proposalId: finding.proposalId })}
        </p>
      ) : null}
      {failure === null ? null : (
        <FormAlert testId="instruction-drift-failure">{failure}</FormAlert>
      )}
    </li>
  );
}
