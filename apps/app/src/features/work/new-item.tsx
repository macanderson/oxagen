"use client";
// New work item (roadmap mockups/src/work.js `DIALOGS.newwork`): a person
// enters an item by title, with an optional description and repository. The
// item has no collector and its origin is manual. Triage suggests its
// priority and drafts its brief, and the dialog opens the new item's page.
//
// The button stays on the page for a person whose role cannot enter work. It
// is disabled and says why, and the server refuses the write either way
// (actions.ts). An empty title is refused here, before anything is sent.
import { PlusIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useId, useState } from "react";
import { routes } from "@/shared/safe-path";
import {
  buttonSecondary,
  fieldHint,
  fieldLabel,
  inputBase,
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { createWorkItem } from "./actions";
import { UNANSWERED, useListActionFailure } from "./list-action-failure";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function FieldRow({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className={fieldHint}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function NewWorkItem({
  org,
  ws,
  canControl,
  testId = "work-new-item",
}: {
  org: string;
  ws: string;
  /** Whether the viewer's roles admit entering work (`viewer.canControl`). */
  canControl: boolean;
  /** The opener's test id; the Inbox's empty state draws a second opener. */
  testId?: string;
}) {
  const t = useTranslations("work.newItem");
  const failureText = useListActionFailure();
  const navigate = useNavigate();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const title = text(form, "title").trim();
    if (title === "") {
      setFailure(t("titleRequired"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await createWorkItem(org, ws, {
        title,
        description: text(form, "description"),
        repository: text(form, "repository"),
      });
      if (result.ok) {
        setOpen(false);
        navigate.push(routes.workItem(org, ws, result.value.number));
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        disabled={!canControl}
        aria-describedby={canControl ? undefined : reasonId}
        title={canControl ? undefined : t("noRole")}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        <PlusIcon aria-hidden="true" />
        {t("open")}
      </button>
      {canControl ? null : (
        <span id={reasonId} className="sr-only">
          {t("noRole")}
        </span>
      )}
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title")}
        testId="work-new-item-dialog"
      >
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
        >
          <p className="text-base text-muted-foreground">{t("body")}</p>
          <FieldRow id="work-new-title" label={t("fields.title")}>
            <input
              id="work-new-title"
              name="title"
              autoComplete="off"
              aria-required="true"
              placeholder={t("fields.titlePlaceholder")}
              className={inputBase}
            />
          </FieldRow>
          <FieldRow
            id="work-new-description"
            label={t("fields.description")}
            hint={t("fields.descriptionHint")}
          >
            <textarea
              id="work-new-description"
              name="description"
              rows={3}
              aria-describedby="work-new-description-hint"
              className={textareaBase}
            />
          </FieldRow>
          <FieldRow
            id="work-new-repository"
            label={t("fields.repository")}
            hint={t("fields.repositoryHint")}
          >
            <input
              id="work-new-repository"
              name="repository"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="work-new-repository-hint"
              className={`${inputBase} font-mono`}
            />
          </FieldRow>
          {failure === null ? null : (
            <FormAlert testId="work-action-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("submit")}
            pendingLabel={t("pending")}
            testId="work-new-item-submit"
          />
        </form>
      </SheetDialog>
    </>
  );
}
