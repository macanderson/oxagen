import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;
export const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
export function useSkillFailure(): (failure: Failure) => string {
  const t = useTranslations("skills.console.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
        return t("denied");
      case "pending_approval":
        return t("pending", { id: failure.accessRequestId });
      case "invalid":
        return t("invalid");
      default:
        switch (failure.code) {
          case "skill_config_invalid":
            return t("invalidConfig");
          case "skill_config_not_merged":
            return t("notMerged");
          case "skill_repository_unbound":
            return t("repositoryMissing");
          case "skill_repository_changed":
            return t("repositoryChanged");
          case "skill_repository_identity_changed":
            return t("identityChanged");
          case "skill_production_branch_missing":
            return t("branchMissing");
          case "skill_config_already_imported":
            return t("alreadyImported");
          case "skill_config_digest_changed":
            return t("digestChanged");
          case "skill_config_missing":
            return t("missingVersion");
          case "skill_catalog_invalid":
            return t("catalogInvalid");
          case "skill_catalog_too_large":
            return t("catalogTooLarge");
          default:
            return t("refused", { code: failure.code });
        }
    }
  };
}
