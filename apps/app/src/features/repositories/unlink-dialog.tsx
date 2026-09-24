"use client";
// Unlink a repository (mockup `DLG_EXT.repounlink`): what stops reaching the
// workspace, that the repository itself is untouched, that records published
// there stop steering runs here at once while recorded runs keep their
// hashes, and what becomes of its working copies. Unlinking is workspace
// membership, not a committed file, so it opens no pull request, and
// `unlink_repository` writes it as a governed action.
//
// The repository stays in the table as not linked, so linking it back is the
// same round trip from the repository dialog.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormAlert } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import { unlinkWorkspaceRepository } from "./actions";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";
import { buttonDanger, code, note } from "./parts";
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

  async function submit() {
    if (row?.bindingId == null || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await unlinkWorkspaceRepository(org, ws, row.bindingId);
      if (result.ok)
        onUnlinked(t("done", { repository: result.value.fullName, workspace }));
      else setFailure(failureText(result));
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
          onClose();
        }
      }}
      title={
        row === null ? "" : t("title", { repository: row.fullName, workspace })
      }
      closeLabel={t("keep")}
      testId="unlink-dialog"
      footer={
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
      }
    >
      {row === null ? null : (
        <div className="flex flex-col gap-2.5">
          {failure === null ? null : (
            <FormAlert testId="unlink-failure">{failure}</FormAlert>
          )}
          <p className={note}>{t.rich("body", { code })}</p>
          {treeState(row.tree) === "governed" ? (
            <p
              data-testid="unlink-governed"
              className="rounded-lg border border-error/40 bg-error/8 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground"
            >
              {t("governed", { workspace })}
            </p>
          ) : null}
          <p
            data-testid="unlink-copies"
            data-state="not-recorded"
            data-gap={REPOSITORY_GAPS.lifecycle}
            className="rounded-lg border border-border bg-hl px-3.5 py-2.5 text-[13px] leading-relaxed text-muted-foreground"
          >
            {t("copies")}
          </p>
        </div>
      )}
    </SheetDialog>
  );
}
