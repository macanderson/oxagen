"use client";
// The frame every Organization write shares: a button that opens a dialog, the
// fields the caller supplies, and one submit that runs the write. A refusal is
// named in the dialog and changes nothing; a write that answered reloads the
// section it changed, so the table redraws from the kernel rather than from
// state this component kept.
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";

export type DialogCopy = {
  open: string;
  title: string;
  confirm: string;
  pending: string;
};

export function WriteDialog<O>({
  copy,
  testId,
  submit,
  onDone,
  children,
}: {
  copy: DialogCopy;
  testId: string;
  /** Reads the dialog's fields and performs the write. */
  submit: (form: FormData) => Promise<ActionResult<O>>;
  /** Runs after the write answered ok, with the dialog already closed. */
  onDone: () => void;
  /** The dialog's fields; a confirmation has a sentence instead. */
  children?: ReactNode;
}) {
  const failureText = useActionFailure();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setFailure(null);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const result = await submit(form);
      if (result.ok) {
        setOpen(false);
        onDone();
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
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {copy.open}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={copy.title}
        testId={testId}
      >
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          {children}
          {failure === null ? null : (
            <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={copy.confirm}
            pendingLabel={copy.pending}
          />
        </form>
      </SheetDialog>
    </>
  );
}

/** Every value a repeated field carries, as the text the actions take. */
export function textValues(form: FormData, field: string): string[] {
  return form.getAll(field).filter((value) => typeof value === "string");
}

/** One field's text, or the empty string when the form does not carry it. */
export function textValue(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}
