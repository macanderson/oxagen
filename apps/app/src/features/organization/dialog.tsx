"use client";
// The frame every Organization write shares: a button that opens a dialog, the
// fields the caller supplies, and one submit that runs the write. A refusal is
// named in the dialog and changes nothing; a write that answered reloads the
// section it changed, so the table redraws from the kernel rather than from
// state this component kept.
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
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
  done,
  primary = false,
  wide = false,
  children,
}: {
  copy: DialogCopy;
  /** Draw the opening button gold: the screen's one primary action. */
  primary?: boolean;
  /** The mockup's 600px dialog, for an editor that needs two columns. */
  wide?: boolean;
  testId: string;
  /** Reads the dialog's fields and performs the write. */
  submit: (form: FormData) => Promise<ActionResult<O>>;
  /**
   * Runs after the write answered ok, with the dialog already closed, and is
   * handed what the write returned — a create navigates to the record it made.
   *
   * With `done` below, it runs when the person dismisses the result instead,
   * because the dialog stays open to show it first.
   */
  onDone: (value: O) => void;
  /**
   * What the write left the person to read, when it left anything: a pull
   * request they now have to merge, a count they should see. Returning a node
   * keeps the dialog open with that node in place of the form and a button that
   * closes it, which is what then runs `onDone`. Returning null closes
   * immediately, so a write whose answer is only sometimes worth reading —
   * `proposed` yes, `unchanged` no — needs no second dialog.
   *
   * It exists because `onDone` navigates, and there is nowhere after a
   * navigation to put a URL the person cannot reconstruct.
   */
  done?: {
    /** Dismisses the panel. Part of `done` so a panel cannot exist unlabelled. */
    close: string;
    render: (value: O) => ReactNode;
  };
  /** The dialog's fields; a confirmation has a sentence instead. */
  children?: ReactNode;
}) {
  const failureText = useActionFailure();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The answer being read, when `done` asked to keep the dialog open for it.
  const [result, setResult] = useState<{ value: O } | null>(null);

  function finish(value: O) {
    setOpen(false);
    setResult(null);
    onDone(value);
  }

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      // Dismissing the dialog is dismissing the result: the write already
      // happened, so `onDone` still runs and the section still reloads.
      const pendingResult = result;
      setResult(null);
      if (pendingResult) onDone(pendingResult.value);
    }
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const answer = await submit(form);
      if (answer.ok) {
        const panel = done?.render(answer.value) ?? null;
        if (panel === null) finish(answer.value);
        else setResult({ value: answer.value });
      } else {
        setFailure(failureText(answer));
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
        className={primary ? buttonPrimary : buttonSecondary}
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
        wide={wide}
      >
        {result === null ? (
          <form
            onSubmit={(e) => void onSubmit(e)}
            className="flex flex-col gap-3"
          >
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
        ) : (
          <div className="flex flex-col gap-3" data-testid={`${testId}-done`}>
            {done?.render(result.value)}
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                finish(result.value);
              }}
            >
              {done?.close}
            </button>
          </div>
        )}
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
