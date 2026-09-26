// The sentence a refused Tools write shows. The kernel classified the refusal
// and put the handler's HandlerError reason in `code` (§3.2). Each reason
// import_tools, set_tool_classification, set_kill_switch, the auto-approval
// writes, create_connection, get_connection, register_mcp_server and the
// toolbelt writes (ADR-192) throw has its own sentence; any other code is
// printed as recorded.
//
// `register_mcp_server` refuses an endpoint only this deployment can reach,
// and `create_connection` refuses an unregistered connector, with errors the
// seam has no code for: both arrive as `unavailable` under `kernel_failure`.
// Naming either one here would need a code the kernel does not carry.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useActionFailure(
  /**
   * `rules` for the auto-approval writes that run the consequence check:
   * saving a rule and switching one on. Those also ask for the org role
   * accountable for every consequence the rule's tools carry, so an Admin can
   * be refused a rule over a tool that moves money, and the Owner-or-Admin
   * sentence would name a role the person already holds. Deleting a rule and
   * switching one off ask only for that pair, so they take the default.
   */
  on: "tools" | "rules" = "tools",
): (failure: ActionFailure) => string {
  const t = useTranslations("tools.actions.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
            return on === "rules"
              ? t("consequenceRoleRequired")
              : t("orgRoleRequired");
          case "no_role_covers_all_tags":
            return t("noRoleCoversAllTags");
          case "rule_id_taken":
            return t("ruleIdTaken");
          // Both concurrency refusals: `rule_changed` is the action finding the
          // rule moved since the editor rendered it, `rule_set_changed` the
          // handler finding the set moved under its lock. The person does the
          // same thing about either one.
          case "rule_changed":
          case "rule_set_changed":
            return t("ruleChanged");
          case "approval_rule_not_found":
            return t("ruleNotFound");
          case "no_tool_matches":
            return t("noToolMatches");
          case "rule_not_gated":
            return t("ruleNotGated");
          case "measure_not_declared":
            return t("measureNotDeclared");
          case "measure_wrong_type":
            return t("measureWrongType");
          case "too_many_consequences":
            return t("tooManyConsequences");
          case "no_principal":
            return t("noPrincipal");
          case "server_not_found":
            return t("serverNotFound");
          case "tool_version_not_found":
            return t("versionNotFound");
          case "kill_switch_on":
            return t("killSwitchOn");
          // The toolbelt writes (ADR-192).
          case "toolbelt_slug_taken":
            return t("toolbeltSlugTaken");
          case "toolbelt_slug_empty":
            return t("toolbeltSlugEmpty");
          case "toolbelt_not_found":
            return t("toolbeltNotFound");
          case "toolbelt_in_use":
            return t("toolbeltInUse");
          case "all_tools_is_derived":
            return t("allToolsIsDerived");
          case "tool_unavailable":
            return t("toolUnavailable");
          case "tool_not_found":
            return t("toolNotFound");
          case "tool_server_not_found":
            return t("toolServerNotFound");
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
