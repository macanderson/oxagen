"use client";
// The Context PR writes on the page: open a proposal's Context PR (or run its
// checks again), dismiss a proposal with a reason, and merge. Open and dismiss
// sit behind a confirming dialog; merge is the panel's one primary action and
// stays disabled until every check has passed. A refusal is named where the
// person acted and changes nothing; a completed write reloads the view it
// leads to.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ProposalStatus } from "@/data/contracts/steering";
import type { ActionResult } from "@/server/kernel";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { dismissProposal, mergeContextPr, openContextPr } from "./actions";

type Copy = {
  open: string;
  title: string;
  body: string;
  confirm: string;
  pending: string;
};

/** Runs a write; ok navigates to `after`, a refusal returns its sentence. */
function useWrite() {
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function run(
    write: () => Promise<ActionResult<unknown>>,
    after: SafePath,
  ): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setFailure(null);
    try {
      const result = await write();
      if (result.ok) {
        navigate.replace(after);
        return true;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
    return false;
  }
  return { pending, failure, setFailure, run };
}

function WriteDialog({
  copy,
  testId,
  fields,
  write,
  after,
}: {
  copy: Copy;
  testId: string;
  fields?: ReactNode;
  write: (form: FormData) => Promise<ActionResult<unknown>>;
  after: SafePath;
}) {
  const [open, setOpen] = useState(false);
  const { pending, failure, setFailure, run } = useWrite();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (await run(() => write(form), after)) setOpen(false);
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
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={copy.title}
        testId={testId}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{copy.body}</p>
          {fields}
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

type Target = { org: string; ws: string; proposalId: string };

/** Open (or re-run) and dismiss, for the states each applies to. */
export function ProposalWrites({
  org,
  ws,
  proposalId,
  status,
}: Target & { status: ProposalStatus }) {
  const t = useTranslations("steering.actions");
  // Only `merged` and `rejected` are terminal. `checks_passed` is not: when the
  // head moves after the checks clear, merge_context_pr refuses with
  // `head_moved` and tells the person to run the checks again
  // (packages/handlers/src/context.pr.merge.ts). Suppressing the re-run control
  // in that state hid the only thing that invokes open_context_pr, so the
  // Context PR could not be merged from the app after any later edit. Merge
  // stays gated on `checks_passed` on its own, below.
  const settled = status === "merged" || status === "rejected";
  const rerun = status !== "proposed";
  const prs = routes.steering(org, ws, { tab: "prs", proposal: proposalId });
  return (
    <>
      {settled ? null : (
        <WriteDialog
          testId="open-context-pr"
          copy={{
            open: t(rerun ? "open.rerun" : "open.open"),
            title: t(rerun ? "open.rerun" : "open.title"),
            body: t("open.body"),
            confirm: t(rerun ? "open.rerunConfirm" : "open.confirm"),
            pending: t("open.pending"),
          }}
          write={() => openContextPr(org, ws, proposalId)}
          after={prs}
        />
      )}
      {status === "merged" || status === "rejected" ? null : (
        <WriteDialog
          testId="dismiss-proposal"
          copy={{
            open: t("dismiss.open"),
            title: t("dismiss.title"),
            body: t("dismiss.body"),
            confirm: t("dismiss.confirm"),
            pending: t("dismiss.pending"),
          }}
          fields={
            <label className="flex flex-col gap-1 text-sm text-foreground">
              <span>{t("dismiss.reason")}</span>
              <textarea
                name="reason"
                required
                maxLength={2000}
                rows={3}
                className={inputBase}
              />
            </label>
          }
          write={(form) => {
            const reason = form.get("reason");
            return dismissProposal(
              org,
              ws,
              proposalId,
              typeof reason === "string" ? reason : "",
            );
          }}
          after={routes.steering(org, ws, { tab: "proposals" })}
        />
      )}
    </>
  );
}

/** Merge pull request: disabled with its reason until the checks passed. */
export function MergeContextPr({
  org,
  ws,
  proposalId,
  blocked,
}: Target & { blocked: boolean }) {
  const t = useTranslations("steering.actions.merge");
  const { pending, failure, run } = useWrite();

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    void run(
      () => mergeContextPr(org, ws, proposalId),
      routes.steering(org, ws, { tab: "prs", proposal: proposalId }),
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {failure === null ? null : (
        <FormAlert testId="merge-context-pr-failure">{failure}</FormAlert>
      )}
      <button
        type="submit"
        disabled={blocked || pending}
        className={blocked ? buttonSecondary : buttonPrimary}
      >
        {pending ? t("pending") : t("confirm")}
      </button>
      {blocked ? (
        <p className="text-xs text-muted-foreground">{t("blocked")}</p>
      ) : null}
    </form>
  );
}
