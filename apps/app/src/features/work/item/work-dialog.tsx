"use client";
// The frame every Work item dialog shares (roadmap mockups/src/work.js
// DIALOGS): the title, the body, Cancel, then the one confirm, a refusal
// named in the page's words, and the pending state while the write runs.
//
// The dialog is `data-testid="work-dialog-<name>"` and its confirm
// `work-dialog-<name>-submit`. Escape, the header's close button and Cancel
// all close it, and focus goes back to the button that opened it. A write
// that succeeded closes the dialog and reads the item again, unless it left
// something to read first (a return whose new send was refused), in which
// case that is shown and the item is read again when the dialog closes. A
// refused write keeps the dialog open with its reason and reads the item
// again too, so a retry names the item's current version.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";

export type DialogName =
  | "send"
  | "edit-brief"
  | "correct-triage"
  | "keep-separate"
  | "keep-in-scope"
  | "stop"
  | "return"
  | "accept"
  | "close"
  | "reopen";

/**
 * What a dialog's submit came to: done, done with a line to read first, or
 * not done with a sentence. `refused` marks a write the server refused, as
 * opposed to a form the dialog would not send.
 */
export type SubmitOutcome =
  | { ok: true; notice?: string }
  | { ok: false; message: string; refused?: boolean };

/** What every dialog takes from the head that opens it. */
export type DialogControl = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The write succeeded: close the dialog and read the item again. */
  onDone: () => void;
};

export function WorkDialog({
  name,
  open,
  onOpenChange,
  onDone,
  title,
  subtitle,
  wide = false,
  submitLabel,
  pendingLabel,
  danger = false,
  blocked = false,
  submitDisabled = false,
  footerNote,
  submit,
  children,
}: DialogControl & {
  name: DialogName;
  title: string;
  /** The item's number, under the title. */
  subtitle?: string;
  wide?: boolean;
  submitLabel: string;
  pendingLabel: string;
  /** The confirm ends something (a send, a run), so it reads as danger and never gold. */
  danger?: boolean;
  /** The write cannot run at all: the body says why, and the dialog offers only Close. */
  blocked?: boolean;
  /** The write cannot run yet: the confirm stays disabled until the person finishes the form. */
  submitDisabled?: boolean;
  footerNote?: ReactNode;
  submit: (form: FormData) => Promise<SubmitOutcome>;
  children: ReactNode;
}) {
  const t = useTranslations("workItem.dialog");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const formId = `work-dialog-${name}-form`;

  function change(next: boolean) {
    if (!next) {
      setFailure(null);
      if (notice !== null) {
        // The write already happened, so dismissing what it left is the
        // moment to read the item again.
        setNotice(null);
        onDone();
        return;
      }
    }
    onOpenChange(next);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked || submitDisabled) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const outcome = await submit(form);
      if (!outcome.ok) {
        setFailure(outcome.message);
        // A refused write may have changed part of the item (a save that
        // passed before its approval was refused), so the page reads the
        // item again and the next press names its current version.
        if (outcome.refused === true) navigate.refresh();
      } else if (outcome.notice !== undefined) setNotice(outcome.notice);
      else onDone();
    } catch {
      setFailure(failureText(UNANSWERED));
      navigate.refresh();
    } finally {
      setPending(false);
    }
  }

  const offersSubmit = notice === null && !blocked;
  return (
    <SheetDialog
      open={open}
      onOpenChange={change}
      title={title}
      subtitle={subtitle}
      wide={wide}
      testId={`work-dialog-${name}`}
      headerClose={offersSubmit}
      closeLabel={offersSubmit ? t("cancel") : t("close")}
      footerNote={offersSubmit ? footerNote : undefined}
      footer={
        offersSubmit ? (
          <SubmitButton
            form={formId}
            testId={`work-dialog-${name}-submit`}
            pending={pending}
            label={submitLabel}
            pendingLabel={pendingLabel}
            fullWidth={false}
            danger={danger}
            disabled={submitDisabled}
          />
        ) : undefined
      }
    >
      {notice === null ? (
        <form
          id={formId}
          onSubmit={(event) => void onSubmit(event)}
          className="flex flex-col gap-3"
        >
          {children}
          {failure === null ? null : (
            <FormAlert testId="work-action-failure">{failure}</FormAlert>
          )}
        </form>
      ) : (
        <p
          role="status"
          data-testid="work-action-notice"
          className="text-sm text-foreground"
        >
          {notice}
        </p>
      )}
    </SheetDialog>
  );
}

/** One field's text, or the empty string when the form does not carry it. */
export function formText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}
