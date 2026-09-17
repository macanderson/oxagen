"use client";
// Binding the detected repository from wherever the operator is standing. The
// gate's provisional banner on Fleet used to link at the register flow's run
// step to reach the bind control, but that step short-circuits to "no agent to
// wrap yet" unless the URL carries the identity, and the gate record holds no
// agent id to put there — so the banner's only action was a dead end and the
// workspace stayed provisional until the window expired. `bind_main_repository`
// takes the workspace and the repository and nothing else, so the banner binds
// where it stands.
import { type SyntheticEvent, useState } from "react";
import type { DetectedRepository } from "@/data/contracts/onboarding";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { bindMainRepository } from "../actions";
import { UNANSWERED, useOnboardingFailure } from "../failure";

export function BindRepository({
  org,
  ws,
  repository,
  label,
  pendingLabel,
  testId,
}: {
  org: string;
  ws: string;
  repository: DetectedRepository;
  /** The action's own copy, so each caller keeps its own wording. */
  label: string;
  pendingLabel: string;
  testId: string;
}) {
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function bind(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await bindMainRepository(org, ws, {
        owner: repository.owner,
        name: repository.name,
      });
      // The bound repository closes the provisional window, so the page the
      // banner sits on re-reads rather than navigating anywhere.
      if (result.ok) navigate.refresh();
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {failure === null ? null : (
        <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
      )}
      <form
        onSubmit={(e) => void bind(e)}
        className="flex"
        data-testid={testId}
      >
        <SubmitButton
          pending={pending}
          label={label}
          pendingLabel={pendingLabel}
          fullWidth={false}
        />
      </form>
    </div>
  );
}
