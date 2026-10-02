"use client";
// The triage decisions a person makes (roadmap mockups/src/work.js
// `wrk-correct`, `wrk-dupkeep`): correct triage's priority or labels, set the
// priority after triage failed, and keep an item triage held as a duplicate or
// out of scope. Each is revise_work_triage with the person's reason, so the
// change is kept on the item and triage's own suggestion stays in the history.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { WorkPriorityLabel } from "@/data/contracts/work";
import { buttonSmall, fieldHint, fieldLabel, inputBase } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import { reviseTriage } from "../actions";
import { useActionFailure } from "./action-failure";
import { ReasonField } from "./fields";
import { useBlockText } from "./phrases";
import type { ItemData } from "./view";
import {
  type DialogControl,
  formText,
  type SubmitOutcome,
  WorkDialog,
} from "./work-dialog";

const PRIORITIES: readonly WorkPriorityLabel[] = ["P0", "P1", "P2", "P3"];

type Place = { org: string; ws: string; detail: ItemData };

/**
 * Correct triage, or Set priority after triage failed. Only the fields the
 * person changed are sent, so a correction never restates triage's value as
 * the person's own.
 */
export function CorrectTriageDialog({
  org,
  ws,
  detail,
  failed,
  ...control
}: Place & DialogControl & { failed: boolean }) {
  const t = useTranslations("workItem.correct");
  const failureText = useActionFailure();
  const current = detail.item.priority.label;
  const labels = detail.triage.labels.value ?? [];
  const number = detail.item.number;

  async function submit(form: FormData): Promise<SubmitOutcome> {
    const picked = formText(form, "priority");
    const priority = PRIORITIES.find((p) => p === picked);
    const nextLabels = formText(form, "labels")
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== "");
    const labelsChanged = nextLabels.join("\n") !== labels.join("\n");
    if (failed && priority === undefined) {
      return { ok: false, message: t("choosePriorityFirst") };
    }
    if ((priority === undefined || priority === current) && !labelsChanged) {
      return { ok: false, message: t("nothingChanged") };
    }
    const result = await reviseTriage(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      reason: formText(form, "reason"),
      ...(priority !== undefined && priority !== current ? { priority } : {}),
      ...(labelsChanged ? { labels: nextLabels } : {}),
    });
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  return (
    <WorkDialog
      name="correct-triage"
      {...control}
      title={failed ? t("failedTitle") : t("title")}
      subtitle={number}
      submitLabel={t("submit")}
      pendingLabel={t("pending")}
      submit={submit}
    >
      <p className="text-sm text-muted-foreground">
        {failed ? t("failedBody", { number }) : t("body", { number })}
      </p>
      <div className="flex flex-col">
        <label htmlFor="work-correct-priority" className={fieldLabel}>
          {t("priority")}
        </label>
        <select
          id="work-correct-priority"
          name="priority"
          defaultValue={current ?? ""}
          required={failed}
          className={inputBase}
        >
          {current === null ? <option value="">{t("choosePriority")}</option> : null}
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col">
        <label htmlFor="work-correct-labels" className={fieldLabel}>
          {t("labels")}
        </label>
        <input
          id="work-correct-labels"
          name="labels"
          defaultValue={labels.join(", ")}
          aria-describedby="work-correct-labels-hint"
          className={inputBase}
        />
        <p id="work-correct-labels-hint" className={fieldHint}>
          {t("labelsHint")}
        </p>
      </div>
      <ReasonField
        id="work-correct-reason"
        label={t("reason")}
        hint={t("reasonHint")}
      />
    </WorkDialog>
  );
}

/**
 * Keep an item triage held: as its own item when triage suggested a
 * duplicate, or in scope when triage marked it out of scope. Both record the
 * person's outcome, `triaged`, with their reason.
 */
export function KeepDialog({
  org,
  ws,
  detail,
  variant,
  ...control
}: Place & DialogControl & { variant: "separate" | "in-scope" }) {
  const t = useTranslations("workItem.keep");
  const failureText = useActionFailure();
  const number = detail.item.number;

  async function submit(form: FormData): Promise<SubmitOutcome> {
    const result = await reviseTriage(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      reason: formText(form, "reason"),
      outcome: "triaged",
    });
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  const separate = variant === "separate";
  return (
    <WorkDialog
      name={separate ? "keep-separate" : "keep-in-scope"}
      {...control}
      title={separate ? t("separateTitle") : t("inScopeTitle")}
      subtitle={number}
      submitLabel={separate ? t("separateSubmit") : t("inScopeSubmit")}
      pendingLabel={t("pending")}
      submit={submit}
    >
      <p className="text-sm text-muted-foreground">
        {separate ? t("separateBody", { number }) : t("inScopeBody", { number })}
      </p>
      <ReasonField
        id={`work-keep-${variant}-reason`}
        label={t("reason")}
        hint={t("reasonHint")}
      />
    </WorkDialog>
  );
}

/** The Triage panel's Correct triage control, with its dialog. */
export function CorrectTriageControl({ org, ws, detail }: Place) {
  const t = useTranslations("workItem.actions");
  const blockText = useBlockText();
  const navigate = useNavigate();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const reason = detail.viewer.canControl ? null : blockText({ kind: "control" });
  return (
    <>
      <button
        type="button"
        data-testid="work-action-correct-triage"
        className={buttonSmall}
        disabled={reason !== null}
        title={reason ?? undefined}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("correctTriage")}
      </button>
      {reason === null ? null : (
        <span id={reasonId} hidden>
          {reason}
        </span>
      )}
      <CorrectTriageDialog
        org={org}
        ws={ws}
        detail={detail}
        failed={false}
        open={open}
        onOpenChange={setOpen}
        onDone={() => {
          setOpen(false);
          navigate.refresh();
        }}
      />
    </>
  );
}
