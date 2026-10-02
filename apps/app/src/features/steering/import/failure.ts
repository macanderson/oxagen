// The sentence a refused or failed import call shows in the dialog. The
// kernel classified the refusal and put the handler's HandlerError reason in
// `code` (ARCHITECTURE.md §3.2). Each reason commit_markdown_import and its
// steering PR opener throw has its own sentence, an organization out of
// credit for the parse's model calls is told so, and any other code is printed
// as recorded.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type ImportFailure = Exclude<ActionResult<unknown>, { ok: true }>;

/** The dialog's own refusal: rows the commit cannot carry in one call. */
export const TOO_LARGE = {
  ok: false,
  reason: "invalid",
  code: "import_too_large",
} as const satisfies ImportFailure;

/** The file a refused parse input names, as `documents.3.content` names the fourth file sent. */
export function fileOfField(
  field: string | undefined,
  filenames: readonly string[],
): string | null {
  const m = field === undefined ? null : /^documents\.(\d+)\b/.exec(field);
  if (m === null) return null;
  return filenames[Number(m[1])] ?? null;
}

export function useImportFailure(): (
  failure: ImportFailure,
  file: string | null,
) => string {
  const t = useTranslations("steering.import.failure");
  return (failure, file) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
          case "no_principal":
            return t("denied");
          case "conflict_unresolved":
            return t("conflictUnresolved");
          case "policy_invalid":
            return t("policyInvalid");
          case "nothing_to_import":
            return t("nothingToImport");
          case "duplicate_lineage":
            return t("duplicateLineage");
          case "duplicate_path":
            return t("duplicatePath");
          case "too_many_files":
            return t("tooManyFiles");
          case "import_branches_exhausted":
            return t("branchesExhausted");
          case "import_branch_exists":
          case "import_branch_moved":
          case "import_branch_missing":
          case "import_pr_not_open":
            return t("branchMoved");
          case "steering_repo_required":
            return t("steeringRepoRequired");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        if (failure.code === TOO_LARGE.code) return t("tooLarge");
        return file === null ? t("invalidInput") : t("invalid", { file });
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
        return t("exhausted", { code: failure.code });
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}
