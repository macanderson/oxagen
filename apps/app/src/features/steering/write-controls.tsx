"use client";
// The steering PR writes on the page: open a proposal's steering PR (or run
// its checks again), dismiss a proposal with a reason, approve, merge, merge
// without review, revert a merged steering PR, restore a drifted managed
// block, and drop one record from a memory PR. Open, dismiss, and revert sit
// behind a confirming dialog. Merge is the panel's one primary action and
// stays disabled until every check has passed. A refusal is named where the
// person acted and changes nothing. A completed write reloads the view it
// leads to, except a drop, which marks its card in place, and a revert, which
// links the pull request it opened in place.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ProposalStatus } from "@/data/contracts/steering";
import type { ActionResult } from "@/server/kernel";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  linkText,
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { PullRequestLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  approveContextPr,
  dismissProposal,
  dropMemoryRecord,
  mergeContextPr,
  mergePrWithoutReview,
  openContextPr,
  restoreManagedBlock,
  revertSteeringPr,
  type RevertOpened,
} from "./actions";

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
  governance = false,
}: Target & {
  status: ProposalStatus;
  /**
   * A governance change (#4795). open_context_pr refuses it: setting the mode
   * again runs its steering checks. So it offers dismiss only.
   */
  governance?: boolean;
}) {
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
      {settled || governance ? null : (
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
                className={textareaBase}
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

/** One write behind one button, with its refusal above it. */
function WriteButton({
  label,
  pendingLabel,
  testId,
  blocked = false,
  write,
  after,
}: {
  label: string;
  pendingLabel: string;
  testId: string;
  blocked?: boolean;
  write: () => Promise<ActionResult<unknown>>;
  after: SafePath;
}) {
  const { pending, failure, run } = useWrite();

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    void run(write, after);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {failure === null ? null : (
        <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
      )}
      <button
        type="submit"
        data-testid={testId}
        disabled={blocked || pending}
        className={buttonSecondary}
      >
        {pending ? pendingLabel : label}
      </button>
    </form>
  );
}

/** Approve: the approval a team or regulated merge needs from a member other than the author. */
export function ApproveContextPr({ org, ws, proposalId }: Target) {
  const t = useTranslations("steering.actions.approve");
  return (
    <WriteButton
      testId="approve-context-pr"
      label={t("confirm")}
      pendingLabel={t("pending")}
      write={() => approveContextPr(org, ws, proposalId)}
      after={routes.steering(org, ws, { tab: "prs", proposal: proposalId })}
    />
  );
}

/** Merge without review: an owner's merge of a steering PR no one has approved. */
export function MergeWithoutReview({
  org,
  ws,
  proposalId,
  blocked,
}: Target & { blocked: boolean }) {
  const t = useTranslations("steering.actions.mergeWithoutReview");
  return (
    <WriteButton
      testId="merge-without-review"
      label={t("confirm")}
      pendingLabel={t("pending")}
      blocked={blocked}
      write={() => mergePrWithoutReview(org, ws, proposalId)}
      after={routes.steering(org, ws, { tab: "prs", proposal: proposalId })}
    />
  );
}

/**
 * Revert pull request: open a steering PR that undoes this merged one, behind
 * a confirming dialog. The merged PR's panel does not change, so the revert
 * PR's link takes the button's place once it is open.
 */
export function RevertSteeringPr({ org, ws, proposalId }: Target) {
  const t = useTranslations("steering.actions.revert");
  const failureText = useActionFailure();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<RevertOpened | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await revertSteeringPr(org, ws, proposalId);
      if (result.ok) {
        setOpened(result.value);
        setOpen(false);
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (opened !== null) {
    const number = String(opened.number);
    const url = parsePullRequestUrl(opened.url);
    return (
      <div data-reverted={number} className="flex flex-col gap-1 text-sm">
        <p className="text-foreground">{t("opened", { number })}</p>
        {url === null ? null : (
          <PullRequestLink to={url} className={linkText}>
            {t("goToPr", { number })}
          </PullRequestLink>
        )}
        {opened.check === "failure" ? (
          <p className="text-muted-foreground">{t("checkFailed")}</p>
        ) : null}
      </div>
    );
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
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title")}
        testId="revert-steering-pr"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          {failure === null ? null : (
            <FormAlert testId="revert-steering-pr-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("confirm")}
            pendingLabel={t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}

/** Restore block: put the managed block back in one drifted file of the steering PR. */
export function RestoreManagedBlock({
  org,
  ws,
  proposalId,
  path,
}: Target & { path: string }) {
  const t = useTranslations("steering.actions.restore");
  return (
    <WriteButton
      testId="restore-managed-block"
      label={t("confirm")}
      pendingLabel={t("pending")}
      write={() => restoreManagedBlock(org, ws, proposalId, path)}
      after={routes.steering(org, ws, { tab: "prs", proposal: proposalId })}
    />
  );
}

/**
 * Drop one record from a memory PR. The card stays where it is and shows the
 * commit that dropped it, so the person keeps their place among the others.
 * The cards are keyed by path, so the page's refresh keeps this state.
 */
export function DropMemoryRecord({
  org,
  ws,
  branch,
  path,
  title,
  dropped,
}: {
  org: string;
  ws: string;
  branch: string;
  path: string;
  title: string;
  dropped: { commitSha: string } | null;
}) {
  const t = useTranslations("steering.actions.drop");
  const failureText = useActionFailure();
  const [commit, setCommit] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A drop recorded before this page loaded, or by someone else since, comes
  // in on `dropped` with the next refresh.
  const droppedIn = commit ?? (dropped === null ? null : dropped.commitSha);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await dropMemoryRecord(org, ws, branch, path);
      if (result.ok) setCommit(result.value.commitSha);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (droppedIn !== null) {
    return (
      <p data-dropped="" className="text-xs text-muted-foreground">
        {t("dropped", { commit: droppedIn.slice(0, 7) })}
      </p>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      {failure === null ? null : (
        <FormAlert testId="drop-memory-record-failure">{failure}</FormAlert>
      )}
      <button
        type="submit"
        disabled={pending}
        aria-label={pending ? undefined : t("label", { title })}
        className={buttonSecondary}
      >
        {pending ? t("pending") : t("confirm")}
      </button>
    </form>
  );
}
