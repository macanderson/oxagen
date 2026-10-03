"use client";
// The two writes that run inside a panel rather than behind a dialog.
//
// Record answer answers triage's question on a needs_info item. The answer is
// the person's reason on revise_work_triage with the outcome `triaged`, so it
// is kept on the item, and oxagen writes nothing back to GitHub.
//
// Read the checks again asks GitHub for the pull request's required checks
// now (refresh_work_order_checks). When GitHub could not be read, the reason
// is said beside the button, and the review keeps what it last recorded.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import {
  buttonPrimary,
  buttonSmall,
  fieldHint,
  fieldLabel,
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { refreshChecks, reviseTriage } from "../actions";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { useBlockText } from "./phrases";
import { formText } from "./work-dialog";

type Place = { org: string; ws: string; itemId: string; canControl: boolean };

export function RecordAnswer({
  org,
  ws,
  itemId,
  version,
  canControl,
}: Place & { version: number }) {
  const t = useTranslations("workItem.answer");
  const blockText = useBlockText();
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const reasonId = useId();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const blocked = canControl ? null : blockText({ kind: "control" });

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked !== null) return;
    const answer = formText(new FormData(event.currentTarget), "answer").trim();
    if (answer === "") {
      setFailure(t("empty"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await reviseTriage(org, ws, {
        itemId,
        version,
        reason: answer,
        outcome: "triaged",
      });
      if (!result.ok) setFailure(failureText(result));
      // Read the item again either way, so a retry names its current version.
      navigate.refresh();
    } catch {
      setFailure(failureText(UNANSWERED));
      navigate.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      data-testid="work-answer-form"
      className="flex flex-col"
    >
      <label htmlFor="work-answer" className={fieldLabel}>
        {t("label")}
      </label>
      <textarea
        id="work-answer"
        name="answer"
        rows={3}
        maxLength={2000}
        disabled={blocked !== null}
        aria-describedby="work-answer-hint"
        className={textareaBase}
      />
      <p id="work-answer-hint" className={fieldHint}>
        {t("hint")}
      </p>
      {failure === null ? null : (
        <div className="mt-2">
          <FormAlert testId="work-action-failure">{failure}</FormAlert>
        </div>
      )}
      <div className="mt-3">
        <button
          type="submit"
          data-testid="work-action-record-answer"
          className={buttonPrimary}
          disabled={blocked !== null || pending}
          aria-busy={pending || undefined}
          title={blocked ?? undefined}
          aria-describedby={blocked === null ? undefined : reasonId}
        >
          {t("submit")}
        </button>
        {blocked === null ? null : (
          <span id={reasonId} hidden>
            {blocked}
          </span>
        )}
      </div>
    </form>
  );
}

export function RefreshChecks({
  org,
  ws,
  itemId,
  orderId,
  canControl,
}: Place & { orderId: string }) {
  const t = useTranslations("workItem.refresh");
  const blockText = useBlockText();
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const reasonId = useId();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const blocked = canControl ? null : blockText({ kind: "control" });

  async function press() {
    if (pending || blocked !== null) return;
    setPending(true);
    setFailure(null);
    setUnread(null);
    try {
      const result = await refreshChecks(org, ws, { itemId, orderId });
      if (result.ok) setUnread(result.value.unreadReason);
      else setFailure(failureText(result));
      navigate.refresh();
    } catch {
      setFailure(failureText(UNANSWERED));
      navigate.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        data-testid="work-action-refresh-checks"
        className={buttonSmall}
        disabled={blocked !== null || pending}
        aria-busy={pending || undefined}
        title={blocked ?? undefined}
        aria-describedby={blocked === null ? undefined : reasonId}
        onClick={() => {
          void press();
        }}
      >
        {t("submit")}
      </button>
      {blocked === null ? null : (
        <span id={reasonId} hidden>
          {blocked}
        </span>
      )}
      {unread === null ? null : (
        <p
          role="status"
          data-testid="work-checks-unread"
          className="text-sm text-muted-foreground"
        >
          {t("unread", { reason: unread })}
        </p>
      )}
      {failure === null ? null : (
        <FormAlert testId="work-action-failure">{failure}</FormAlert>
      )}
    </div>
  );
}
