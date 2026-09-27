"use client";
// The warning a code repository shows when an instruction file in it drifted
// from the steering records (#4518). Each finding names the file, and Promote
// to steering asks the platform to propose that file as a steering record
// through `promote_instruction_to_steering`. The proposal reaches the steering
// repo as a steering PR, so nothing steers from the file until that PR merges.
// With no findings the warning draws nothing.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { promoteInstructionToSteering } from "./actions";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { code, note } from "./parts";

const PROMOTE_CAPABILITY = "promote_instruction_to_steering";

/** One instruction file whose content drifted from the steering records. */
export type InstructionDriftFinding = {
  /** The file's path in the repository, such as `AGENTS.md`. */
  path: string;
};

export function InstructionDriftWarning({
  org,
  ws,
  repositoryId,
  findings,
}: {
  org: string;
  ws: string;
  /** The code repository the findings are about. */
  repositoryId: string;
  findings: readonly InstructionDriftFinding[];
}) {
  if (findings.length === 0) return null;
  return (
    <ul data-testid="instruction-drift" className="flex flex-col gap-2">
      {findings.map((finding) => (
        <DriftFinding
          key={finding.path}
          org={org}
          ws={ws}
          repositoryId={repositoryId}
          path={finding.path}
        />
      ))}
    </ul>
  );
}

function DriftFinding({
  org,
  ws,
  repositoryId,
  path,
}: {
  org: string;
  ws: string;
  repositoryId: string;
  path: string;
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
      const result = await promoteInstructionToSteering(org, ws, {
        repositoryId,
        path,
      });
      if (result.ok) setProposalId(result.value.proposalId);
      else setFailure(failureText(result, PROMOTE_CAPABILITY));
    } catch {
      setFailure(failureText(UNANSWERED, PROMOTE_CAPABILITY));
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      data-testid="instruction-drift-finding"
      data-path={path}
      className={`${note} flex flex-col items-start gap-2 border-info`}
    >
      <p className="text-foreground">{t.rich("detected", { path, code })}</p>
      {proposalId === null ? (
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
      ) : (
        <p role="status" data-testid="instruction-drift-promoted">
          {t("promoted", { proposalId })}
        </p>
      )}
      {failure === null ? null : (
        <FormAlert testId="instruction-drift-failure">{failure}</FormAlert>
      )}
    </li>
  );
}
