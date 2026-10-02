"use client";
// The head's actions (roadmap mockups/src/work.js `itemActions()`): the ones
// the item's status offers, the primary last, each a button with
// `data-testid="work-action-<name>"`. An action the viewer's roles do not
// admit stays on screen, disabled, with its reason as its title and its
// accessible description: hiding a button is not a gate, and the handlers
// hold the gate (../actions.ts). Accept stays disabled while the send's gate
// is closed, with the gate's reason, so a refusal at the press is rare.
//
// Retry triage and Approve run in place. Every other action opens its dialog.
// The Send dialog also opens on arrival when the URL carries `?dialog=send`,
// which is how the Work page's Send buttons reach it, and closing it drops the
// query so a reload does not open it again.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { CloseResolution, WorkTargetList } from "@/data/contracts/work";
import type { ActionResult } from "@/server/kernel";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import { buttonDanger, buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { PullRequestLink, SafeLink, useNavigate } from "@/ui/navigation";
import { approveBrief, retryTriage, saveAndApproveBrief } from "../actions";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { EditBriefDialog } from "./brief-dialog";
import { CloseDialog, ReopenDialog } from "./item-dialogs";
import { useBlockText } from "./phrases";
import { AcceptDialog, ReturnDialog } from "./review-dialogs";
import { SendDialog } from "./send-dialog";
import { StopDialog, type StopVariant } from "./stop-dialog";
import { CorrectTriageDialog, KeepDialog } from "./triage-dialogs";
import {
  approvedBrief,
  approvePlan,
  actionBlock,
  canOpenSend,
  type HeadAction,
  type HeadActionName,
  headActions,
  type ItemData,
  latestSend,
} from "./view";
import type { DialogName } from "./work-dialog";

const TONE: Record<HeadAction["tone"], string> = {
  primary: buttonPrimary,
  secondary: buttonSecondary,
  danger: buttonDanger,
};

function ActionButton({
  name,
  tone,
  label,
  reason,
  busy,
  onClick,
}: HeadAction & {
  label: string;
  /** Why the action is held back, or null when it is not. */
  reason: string | null;
  busy: boolean;
  onClick: () => void;
}) {
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        data-testid={`work-action-${name}`}
        data-tone={tone}
        className={TONE[tone]}
        disabled={reason !== null || busy}
        aria-busy={busy || undefined}
        title={reason ?? undefined}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={onClick}
      >
        {label}
      </button>
      {reason === null ? null : (
        <span id={reasonId} hidden>
          {reason}
        </span>
      )}
    </>
  );
}

export function ItemActions({
  org,
  ws,
  detail,
  targets,
  dialog,
}: {
  org: string;
  ws: string;
  detail: ItemData;
  /** The agents that can take a send, or null when that read failed. */
  targets: WorkTargetList | null;
  /** A dialog the URL asks to open on arrival. */
  dialog: "send" | null;
}) {
  const t = useTranslations("workItem.actions");
  const blockText = useBlockText();
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const targetsRead = targets !== null;
  const fromUrl = dialog === "send";
  const [open, setOpen] = useState<DialogName | null>(() =>
    fromUrl && canOpenSend(detail, targetsRead) ? "send" : null,
  );
  const [closePreset, setClosePreset] = useState<CloseResolution | null>(null);
  const [pending, setPending] = useState<HeadActionName | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const actions = headActions(detail);
  const send = latestSend(detail);
  const plan = approvePlan(detail);
  const approved = approvedBrief(detail);
  const item = detail.item;
  const here = routes.workItem(org, ws, item.number);

  function show(name: DialogName) {
    setFailure(null);
    setOpen(name);
  }

  /** Closing a dialog the URL opened drops the query, so a reload does not open it again. */
  function dismiss() {
    setOpen(null);
    if (fromUrl) navigate.advance(here);
  }

  /** A write succeeded: read the item again. */
  function done() {
    setOpen(null);
    if (fromUrl) navigate.replace(here);
    else navigate.refresh();
  }

  async function inPlace(
    name: HeadActionName,
    write: () => Promise<ActionResult<unknown>>,
  ) {
    if (pending !== null) return;
    setPending(name);
    setFailure(null);
    try {
      const result = await write();
      // Read the item again either way: a refused save-and-approve may have
      // saved, and the next press must name the item's current version.
      if (!result.ok) setFailure(failureText(result));
      navigate.refresh();
    } catch {
      setFailure(failureText(UNANSWERED));
      navigate.refresh();
    } finally {
      setPending(null);
    }
  }

  function approve() {
    if (plan.kind === "approve") {
      void inPlace("approve", () =>
        approveBrief(org, ws, {
          itemId: item.id,
          version: item.version,
          itemRevision: item.revision,
          briefRevision: plan.revision,
          briefDigest: plan.digest,
        }),
      );
    } else if (plan.kind === "save-and-approve") {
      void inPlace("approve", () =>
        saveAndApproveBrief(org, ws, {
          itemId: item.id,
          version: item.version,
          itemRevision: item.revision,
          repository: plan.repository,
          criteria: plan.criteria,
        }),
      );
    }
  }

  function label(name: HeadActionName): string {
    switch (name) {
      case "correct-triage":
        return item.status === "triage_failed" ? t("setPriority") : t("correctTriage");
      case "retry-triage":
        return t("retryTriage");
      case "keep-separate":
        return t("keepSeparate");
      case "keep-in-scope":
        return t("keepInScope");
      case "confirm-duplicate":
        return t("confirmDuplicate");
      case "edit-brief":
        return t("editBrief");
      case "approve":
        return item.status === "changed" && plan.kind !== "nothing"
          ? t("approveRevision", { revision: String(plan.revision) })
          : t("approveBrief");
      case "send":
        return t("send");
      case "cancel":
        return t("cancel");
      case "stop":
        return t("stop");
      case "withdraw":
        return t("withdraw");
      case "open-run":
        return t("openRun");
      case "open-pr":
        return t("openPr");
      case "return":
        return t("return");
      case "accept":
        return t("accept");
      case "close":
        return t("close");
      case "reopen":
        return t("reopen");
    }
  }

  function press(name: HeadActionName) {
    switch (name) {
      case "retry-triage":
        void inPlace(name, () => retryTriage(org, ws, { itemId: item.id }));
        return;
      case "approve":
        approve();
        return;
      case "correct-triage":
        show("correct-triage");
        return;
      case "keep-separate":
        show("keep-separate");
        return;
      case "keep-in-scope":
        show("keep-in-scope");
        return;
      case "confirm-duplicate":
        setClosePreset("duplicate");
        show("close");
        return;
      case "close":
        setClosePreset(null);
        show("close");
        return;
      case "edit-brief":
        show("edit-brief");
        return;
      case "send":
        show("send");
        return;
      case "cancel":
      case "stop":
      case "withdraw":
        show("stop");
        return;
      case "return":
        show("return");
        return;
      case "accept":
        show("accept");
        return;
      case "reopen":
        show("reopen");
        return;
      case "open-run":
      case "open-pr":
        return;
    }
  }

  function control(name: DialogName) {
    return {
      open: open === name,
      onOpenChange: (next: boolean) => {
        if (next) show(name);
        else dismiss();
      },
      onDone: done,
    };
  }

  const run = send === null ? undefined : send.runs[send.runs.length - 1];
  const pullRequest = send?.pullRequest ?? null;
  const prUrl = pullRequest === null ? null : parsePullRequestUrl(pullRequest.url);
  const offers = (name: HeadActionName) => actions.some((a) => a.name === name);
  const stopVariant: StopVariant | null = offers("stop")
    ? "stop"
    : offers("withdraw")
      ? "withdraw"
      : offers("cancel")
        ? "cancel"
        : null;
  const place = { org, ws, detail };

  return (
    <div className="flex min-w-0 flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {actions.map((action) => {
          if (action.name === "open-run") {
            return run === undefined ? null : (
              <SafeLink
                key={action.name}
                to={routes.run(org, ws, run.id)}
                data-testid="work-action-open-run"
                className={buttonSecondary}
              >
                {label(action.name)}
              </SafeLink>
            );
          }
          if (action.name === "open-pr") {
            return prUrl === null ? null : (
              <PullRequestLink
                key={action.name}
                to={prUrl}
                data-testid="work-action-open-pr"
                className={buttonSecondary}
              >
                {label(action.name)}
              </PullRequestLink>
            );
          }
          const block = actionBlock(action.name, detail, targetsRead);
          return (
            <ActionButton
              key={action.name}
              {...action}
              label={label(action.name)}
              reason={block === null ? null : blockText(block)}
              busy={pending === action.name}
              onClick={() => {
                press(action.name);
              }}
            />
          );
        })}
      </div>
      {failure === null ? null : (
        <FormAlert testId="work-action-failure">{failure}</FormAlert>
      )}
      {item.status === "triage_failed" ? (
        <CorrectTriageDialog {...place} failed {...control("correct-triage")} />
      ) : null}
      {item.status === "possible_duplicate" ? (
        <KeepDialog {...place} variant="separate" {...control("keep-separate")} />
      ) : null}
      {item.status === "out_of_scope" ? (
        <KeepDialog {...place} variant="in-scope" {...control("keep-in-scope")} />
      ) : null}
      {offers("edit-brief") ? (
        <EditBriefDialog {...place} {...control("edit-brief")} />
      ) : null}
      {targets !== null && approved !== null && detail.nextSend !== null ? (
        <SendDialog
          {...place}
          approved={approved}
          sendKey={detail.nextSend.key}
          targets={targets}
          {...control("send")}
        />
      ) : null}
      {send !== null && stopVariant !== null ? (
        <StopDialog
          {...place}
          send={send}
          variant={stopVariant}
          {...control("stop")}
        />
      ) : null}
      {send !== null && offers("return") ? (
        <ReturnDialog {...place} send={send} {...control("return")} />
      ) : null}
      {send !== null && offers("accept") ? (
        <AcceptDialog {...place} send={send} {...control("accept")} />
      ) : null}
      {offers("close") || offers("confirm-duplicate") ? (
        <CloseDialog {...place} preset={closePreset} {...control("close")} />
      ) : null}
      {offers("reopen") ? <ReopenDialog {...place} {...control("reopen")} /> : null}
    </div>
  );
}
