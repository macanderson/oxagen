"use client";
// The frame every Organization write shares: a button that opens a dialog, the
// fields the caller supplies, and one submit that runs the write. A refusal is
// named in the dialog and changes nothing; a write that answered leaves its
// receipt (`receipt.tsx`) and reloads the section it changed, so the table
// redraws from the kernel rather than from state this component kept.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import {
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { recordReceipt } from "./receipt";

export type DialogCopy = {
  open: string;
  title: string;
  /** A line under the title: the record the write acts on. */
  subtitle?: string;
  confirm: string;
  pending: string;
  /** The receipt line once the write answered; "Saved. Recorded in the audit record." when absent. */
  receipt?: string;
};

export function WriteDialog<O>({
  copy,
  testId,
  submit,
  onDone,
  done,
  primary = false,
  danger = false,
  blocked = false,
  wide = false,
  children,
}: {
  copy: DialogCopy;
  /** Draw the opening button gold: the screen's one primary action. */
  primary?: boolean;
  /**
   * A write that ends something (archive): the row's button and the confirm
   * are the design's `btn danger`, red ink and never gold.
   */
  danger?: boolean;
  /**
   * The confirm is disabled: the body already says why the handler would
   * refuse (an Archive over registered agents), so the button cannot be sent.
   */
  blocked?: boolean;
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
  const tReceipt = useTranslations("organization.receipts");
  const tActions = useTranslations("organization.actions");
  const formId = `${testId}-form`;
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
    if (pending || blocked) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const answer = await submit(form);
      if (answer.ok) {
        recordReceipt(copy.receipt ?? tReceipt("saved"));
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
        className={
          primary ? buttonPrimary : danger ? buttonDanger : buttonSecondary
        }
        onClick={() => {
          setOpen(true);
        }}
      >
        {copy.open}
      </button>
      {/* The design's footer reads Cancel then the confirm, with the header's
          x beside the title. Once a write left something to read, the form
          gives way to it and the one footer button is its close. */}
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={copy.title}
        subtitle={copy.subtitle}
        testId={testId}
        wide={wide}
        headerClose
        closeLabel={result === null ? tActions("cancel") : done?.close}
        footer={
          result === null ? (
            <SubmitButton
              form={formId}
              pending={pending}
              label={copy.confirm}
              pendingLabel={copy.pending}
              fullWidth={false}
              danger={danger}
              disabled={blocked}
            />
          ) : undefined
        }
      >
        {result === null ? (
          <form
            id={formId}
            onSubmit={(e) => void onSubmit(e)}
            className="flex flex-col gap-3"
          >
            {children}
            {failure === null ? null : (
              <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
            )}
          </form>
        ) : (
          <div className="flex flex-col gap-3" data-testid={`${testId}-done`}>
            {done?.render(result.value)}
          </div>
        )}
      </SheetDialog>
    </>
  );
}

/** One field's text, or the empty string when the form does not carry it. */
export function textValue(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}
