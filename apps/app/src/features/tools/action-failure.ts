// The sentence a refused Tools write shows. The kernel classified the refusal
// and put the handler's HandlerError reason in `code` (§3.2). Each reason
// import_tools, set_tool_classification and set_kill_switch throw has its own
// sentence; any other code is printed as recorded.
//
// `org_role_required` is the one reason whose sentence differs by write, because
// the writes do not want the same roles. `set_tool_classification` and
// `set_kill_switch` grant org Owner or Admin and nothing else, so naming those
// two is the whole truth. `import_tools` also grants this workspace's Owner
// (#3143), and since the page now offers that person the control, a refusal
// that told them an org role is what the write needs would contradict the
// control they were just given. So the import path says what its capability
// says, and the caller names which write it is reporting.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

/**
 * Which of the page's writes the sentence is for. `org` covers the two that
 * want an org role only; `import` is `import_tools`, the one that also grants
 * a workspace role.
 */
type ToolsWriteKind = "org" | "import";

export function useActionFailure(
  kind: ToolsWriteKind = "org",
): (failure: ActionFailure) => string {
  const t = useTranslations("tools.actions.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
            return kind === "import"
              ? t("importRoleRequired")
              : t("orgRoleRequired");
          case "no_principal":
            return t("noPrincipal");
          case "server_not_found":
            return t("serverNotFound");
          case "tool_version_not_found":
            return t("versionNotFound");
          case "kill_switch_on":
            return t("killSwitchOn");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        return t("invalid");
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}

/** A write that threw before it answered, as the seam would name it. */
export const UNANSWERED: ActionFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
