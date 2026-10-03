"use client";
// Unlink a repository (mockup `DLG_EXT.repounlink`): what stops reaching the
// workspace, that the repository itself is untouched, that records published
// there stop steering runs here once the unlink takes effect while recorded
// runs keep their hashes, and what becomes of its working copies.
//
// `unlink_repository` answers one of two ways (ADR-212). When
// `workspace.toml` on the steering repository lists the repository, it opens
// a steering PR that removes the entry, and the link stays until a person
// merges it. The dialog stays open, names the PR, and says to merge it. A link
// that predates the steering record is removed at once, and the dialog closes
// with the notice as before.
//
// The repository stays in the table as not linked, so linking it back is the
// same round trip from the repository dialog.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { UnlinkedRepository } from "@/data/contracts/repository";
import { FormAlert } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import { unlinkWorkspaceRepository } from "./actions";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";
import { buttonDanger, code, note } from "./parts";
import { SteeringProposal } from "./steering-proposal";
import { type RepositoryRow, treeState } from "./view";

export function UnlinkDialog({
  org,
  ws,
  workspace,
  row,
  onClose,
  onUnlinked,
}: {
  org: string;
  ws: string;
  workspace: string;
  /** The linked repository to unlink; null keeps the dialog closed. */
  row: RepositoryRow | null;
  onClose: () => void;
  onUnlinked: (message: string) => void;
}) {
  const t = useTranslations("repositories.unlink");
  const failureText = useRepositoriesFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** The unlink a steering PR carries. The dialog shows it until it closes. */
  const [proposed, setProposed] = useState<UnlinkedRepository | null>(null);

  async function submit() {
    if (row?.bindingId == null || pending || proposed !== null) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await unlinkWorkspaceRepository(org, ws, row.bindingId);
      if (!result.ok) setFailure(failureText(result));
      else if (result.value.status === "proposed") setProposed(result.value);
      else
        onUnlinked(t("done", { repository: result.value.fullName, workspace }));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <SheetDialog
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) {
          setFailure(null);
          setProposed(null);
          onClose();
        }
      }}
      title={
        row === null ? "" : t("title", { repository: row.fullName, workspace })
      }
      closeLabel={proposed === null ? t("keep") : undefined}
      testId="unlink-dialog"
      footer={
        proposed === null ? (
          <button
            type="button"
            data-testid="unlink-submit"
            data-touch-target=""
            disabled={pending}
            className={buttonDanger}
            onClick={() => {
              void submit();
            }}
          >
            {pending ? t("pending") : t("submit")}
          </button>
        ) : null
      }
    >
      {row === null ? null : (
        <div className="flex flex-col gap-2.5">
          {failure === null ? null : (
            <FormAlert testId="unlink-failure">{failure}</FormAlert>
          )}
          {proposed === null ? null : (
            <SteeringProposal
              action="unlink"
              fullName={proposed.fullName}
              steeringPullRequest={proposed.steeringPullRequest}
              testId="unlink-proposed"
            />
          )}
          <p className={note}>{t.rich("body", { code })}</p>
          {treeState(row.tree) === "governed" ? (
            <p
              data-testid="unlink-governed"
              className="rounded-lg border border-error/40 bg-error/8 px-3.5 py-2.5 text-sm leading-relaxed text-foreground"
            >
              {t("governed", { workspace })}
            </p>
          ) : null}
          <p
            data-testid="unlink-copies"
            data-state="not-recorded"
            data-gap={REPOSITORY_GAPS.lifecycle}
            className="rounded-lg border border-border bg-hl px-3.5 py-2.5 text-sm leading-relaxed text-muted-foreground"
          >
            {t("copies")}
          </p>
        </div>
      )}
    </SheetDialog>
  );
}
