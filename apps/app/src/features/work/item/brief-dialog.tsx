"use client";
// Edit brief (roadmap mockups/src/work.js `wrk-brief`): the repository the
// work changes and the criteria a person accepts it against. Each criterion
// keeps its key across revisions, a new one gets its key when it is saved,
// and saving leaves a draft revision for the item's current revision
// (save_work_brief). An approved brief never changes: editing one makes the
// next revision, which a person approves before the item can be sent.
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  buttonSmall,
  fieldLabel,
  inputBase,
  textareaBase,
} from "@/ui/control-styles";
import { type CriterionDraft, saveBrief } from "../actions";
import { useActionFailure } from "./action-failure";
import { briefRepository, draftCriteria, type ItemData } from "./view";
import {
  type DialogControl,
  formText,
  type SubmitOutcome,
  WorkDialog,
} from "./work-dialog";

/** owner/name, as save_work_brief takes it. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type Row = { uid: string; draft: CriterionDraft };
type Rows = { rows: Row[]; serial: number };

function blank(): CriterionDraft {
  return {
    criterion: null,
    text: "",
    tag: "code",
    intent: "review",
    evidence: "",
    provenance: "person",
  };
}

function initialRows(detail: ItemData): Rows {
  const drafts = draftCriteria(detail);
  const rows = (drafts.length > 0 ? drafts : [blank()]).map((draft, i) => ({
    uid: draft.criterion ?? `new-${String(i)}`,
    draft,
  }));
  return { rows, serial: rows.length };
}

export function EditBriefDialog({
  org,
  ws,
  detail,
  ...control
}: DialogControl & { org: string; ws: string; detail: ItemData }) {
  const t = useTranslations("workItem.editBrief");
  const failureText = useActionFailure();
  const [state, setState] = useState<Rows>(() => initialRows(detail));
  const { rows } = state;

  function update(uid: string, patch: Partial<CriterionDraft>) {
    setState((before) => ({
      ...before,
      rows: before.rows.map((row) =>
        row.uid === uid ? { uid, draft: { ...row.draft, ...patch } } : row,
      ),
    }));
  }

  async function submit(form: FormData): Promise<SubmitOutcome> {
    const repository = formText(form, "repository").trim();
    if (!REPOSITORY.test(repository)) {
      return { ok: false, message: t("repositoryInvalid") };
    }
    if (rows.length === 0) return { ok: false, message: t("noCriteria") };
    if (rows.some((row) => row.draft.text.trim() === "")) {
      return { ok: false, message: t("emptyCriterion") };
    }
    const result = await saveBrief(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      itemRevision: detail.item.revision,
      repository,
      criteria: rows.map((row) => row.draft),
    });
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  return (
    <WorkDialog
      name="edit-brief"
      {...control}
      onOpenChange={(next) => {
        // A closed editor forgets what it was not asked to save.
        if (!next) setState(initialRows(detail));
        control.onOpenChange(next);
      }}
      title={t("title")}
      subtitle={detail.item.number}
      wide
      submitLabel={t("submit")}
      pendingLabel={t("pending")}
      submit={submit}
    >
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <div className="flex flex-col">
        <label htmlFor="work-brief-repository" className={fieldLabel}>
          {t("repository")}
        </label>
        <input
          id="work-brief-repository"
          name="repository"
          required
          defaultValue={briefRepository(detail) ?? ""}
          placeholder={t("repositoryPlaceholder")}
          className={`${inputBase} font-mono`}
        />
      </div>
      <ol className="flex flex-col gap-3">
        {rows.map((row, index) => {
          const key = row.draft.criterion ?? t("newKey");
          const id = (field: string) => `work-brief-${field}-${row.uid}`;
          return (
            <li
              key={row.uid}
              data-testid="work-brief-criterion"
              className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-dim">{key}</span>
                <button
                  type="button"
                  className={buttonSmall}
                  disabled={rows.length === 1}
                  aria-label={t("remove", { position: String(index + 1) })}
                  onClick={() => {
                    setState((before) => ({
                      ...before,
                      rows: before.rows.filter((r) => r.uid !== row.uid),
                    }));
                  }}
                >
                  {t("removeShort")}
                </button>
              </div>
              <div className="flex flex-col">
                <label htmlFor={id("text")} className={fieldLabel}>
                  {t("criterion", { position: String(index + 1) })}
                </label>
                <textarea
                  id={id("text")}
                  rows={2}
                  required
                  maxLength={2000}
                  value={row.draft.text}
                  onChange={(event) => {
                    update(row.uid, { text: event.currentTarget.value });
                  }}
                  className={textareaBase}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="flex flex-col">
                  <label htmlFor={id("kind")} className={fieldLabel}>
                    {t("kind")}
                  </label>
                  <select
                    id={id("kind")}
                    value={row.draft.intent}
                    onChange={(event) => {
                      update(row.uid, {
                        intent: event.currentTarget.value === "check" ? "check" : "review",
                      });
                    }}
                    className={inputBase}
                  >
                    <option value="check">{t("kinds.check")}</option>
                    <option value="review">{t("kinds.review")}</option>
                  </select>
                </div>
                <div className="flex flex-col">
                  <label htmlFor={id("evidence")} className={fieldLabel}>
                    {t("evidence")}
                  </label>
                  <input
                    id={id("evidence")}
                    maxLength={1000}
                    value={row.draft.evidence}
                    onChange={(event) => {
                      update(row.uid, { evidence: event.currentTarget.value });
                    }}
                    className={inputBase}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <button
          type="button"
          data-testid="work-brief-add"
          className={buttonSmall}
          onClick={() => {
            setState((before) => ({
              serial: before.serial + 1,
              rows: [
                ...before.rows,
                { uid: `new-${String(before.serial)}`, draft: blank() },
              ],
            }));
          }}
        >
          {t("add")}
        </button>
      </div>
    </WorkDialog>
  );
}
