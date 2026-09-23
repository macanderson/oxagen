"use client";
// The kill switch on an agent's own page (`packages/iam/src/kill-switch.ts`,
// ADR-072, #2958): one control that denies every tool call this agent makes
// from its next call boundary and pauses every run of it still live.
//
// The dialog states the blast radius before the confirming button, the way
// Tools' own switch dialog does (`features/tools/switch-controls.tsx`) —
// this is the same emergency deny, scoped to one agent, so it earns the same
// warning. It differs from that dialog in one way: it never turns a switch
// off. Restoring an agent's toolbelt is a decision for Tools › Kill switches,
// where the switch this writes is listed beside every other one, not a
// second control here that could read as "resume" when nothing here resumes
// a run the harness has already stopped taking pause commands from.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { OrgRole } from "@/server/viewer";
import type { AgentPauseOutcome } from "./actions";
import { pauseAgent } from "./actions";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

function Outcome({ pause }: { pause: AgentPauseOutcome }) {
  const t = useTranslations("agents.actions.killSwitch.outcome");
  const failureText = useActionFailure();
  switch (pause.kind) {
    case "paused":
      return (
        <p data-testid="kill-switch-outcome" role="status">
          {t("paused", { count: pause.commandIds.length })}
        </p>
      );
    case "no_live_runs":
      return (
        <p data-testid="kill-switch-outcome" role="status">
          {t("noLiveRuns")}
        </p>
      );
    case "no_agent_key":
      return (
        <p data-testid="kill-switch-outcome" role="status">
          {t("noAgentKey")}
        </p>
      );
    case "failed":
      return (
        <FormAlert testId="kill-switch-outcome">
          {t("failed")} {failureText(pause.failure)}
        </FormAlert>
      );
  }
}

export function AgentKillSwitch({
  org,
  ws,
  agentId,
  agentKey,
  name,
  orgRole,
}: {
  org: string;
  ws: string;
  agentId: string;
  agentKey: string | null;
  name: string;
  /**
   * The viewer's organization role. `set_kill_switch` asserts an Owner or
   * Admin (INV-29), so a viewer it would refuse sees the button disabled with
   * the reason, the way the Run page's record writes do, not a dialog that
   * ends in `org_role_required`.
   */
  orgRole: OrgRole;
}) {
  const t = useTranslations("agents.actions.killSwitch");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{
    changed: boolean;
    pause: AgentPauseOutcome;
  } | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setOutcome(null);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const reason = new FormData(event.currentTarget).get("reason");
    setPending(true);
    setFailure(null);
    try {
      const result = await pauseAgent(
        org,
        ws,
        { agentId, agentKey },
        typeof reason === "string" ? reason : "",
      );
      if (result.ok) {
        setOutcome({
          changed: result.value.changed,
          pause: result.value.pause,
        });
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (orgRole !== "owner" && orgRole !== "admin") {
    return (
      <span className="flex flex-col gap-1">
        <button
          type="button"
          disabled
          data-testid="agent-kill-switch-open"
          className={buttonSecondary}
        >
          {t("open")}
        </button>
        <span
          data-testid="agent-kill-switch-no-role"
          className="max-w-prose text-xs text-muted-foreground"
        >
          {t("needsRole")}
        </span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        data-testid="agent-kill-switch-open"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title", { name })}
        testId="agent-kill-switch-dialog"
      >
        {outcome === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <div
              data-testid="agent-kill-switch-blast-radius"
              className="rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2.5 text-sm"
            >
              <p className="font-medium text-foreground">{t("blastTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("blastBody")}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="agent-kill-switch-reason"
                className="text-sm font-medium text-foreground"
              >
                {t("reason")}
              </label>
              <textarea
                id="agent-kill-switch-reason"
                name="reason"
                rows={2}
                required
                maxLength={500}
                className={inputBase}
              />
            </div>
            {failure === null ? null : (
              <FormAlert testId="agent-kill-switch-failure">
                {failure}
              </FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          </form>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {outcome.changed ? null : (
              <p
                data-testid="agent-kill-switch-unchanged"
                className="text-muted-foreground"
              >
                {t("unchanged")}
              </p>
            )}
            <Outcome pause={outcome.pause} />
            {/* The switch and the pause changed the record; the page still
                shows the read from before. The same offer the Run page's
                record dialogs make: re-read in place, and the tab stays put. */}
            <button
              type="button"
              data-testid="agent-kill-switch-reread"
              className={`${buttonSecondary} self-start`}
              onClick={() => {
                openChange(false);
                navigate.refresh();
              }}
            >
              {t("reread")}
            </button>
          </div>
        )}
      </SheetDialog>
    </>
  );
}
