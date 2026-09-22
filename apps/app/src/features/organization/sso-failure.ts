// The sentence a refused single sign-on write shows. The kernel classified
// the refusal and put the handler's reason in `code`: each reason the SSO
// handlers throw, and each field the actions refuse before any capability
// runs, has its own sentence. Any other code is printed as recorded.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type SsoFailure = Exclude<ActionResult<unknown>, { ok: true }>;

/** A write that threw before it answered, as the seam would name it. */
export const SSO_UNANSWERED: SsoFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

export function useSsoFailure(): (failure: SsoFailure) => string {
  const t = useTranslations("organization.sso.failure");
  const tGroups = useTranslations("organization.ssoGroups.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
        return t("denied");
      case "invalid":
        switch (failure.code) {
          case "provider_id_required":
            return t("providerIdRequired");
          case "display_name_required":
            return t("displayNameRequired");
          case "domain_required":
            return t("domainRequired");
          case "issuer_required":
            return t("issuerRequired");
          case "client_id_required":
            return t("clientIdRequired");
          case "client_secret_required":
            return t("clientSecretRequired");
          case "entry_point_required":
            return t("entryPointRequired");
          case "cert_required":
            return t("certRequired");
          case "cert_required_for_change":
            return t("certRequiredForChange");
          case "group_required":
            return tGroups("groupRequired");
          case "group_duplicate":
            return tGroups("groupDuplicate");
          default:
            // The contract's own refusal. With a field it is that field's
            // format; without one the handler refused the settings as a whole,
            // most often an issuer with no discovery document.
            return failure.field === undefined || failure.field === ""
              ? t("invalidSettings")
              : t("invalid");
        }
      case "conflict":
      case "not_found":
        switch (failure.code) {
          case "dns_record_not_found":
            return t("dnsRecordNotFound");
          case "no_verified_provider":
            return t("noVerifiedProvider");
          case "provider_id_taken":
          case "provider_id_reserved":
            return t("providerIdTaken");
          case "domain_taken":
            return t("domainTaken");
          case "sso_provider_not_found":
            return t("notFound");
          default:
            return t("refused", { code: failure.code });
        }
      case "pending_approval":
        return t("pendingApproval");
      case "exhausted":
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}
