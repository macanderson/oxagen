// The three not-loaded states the Tools page can be in (the mockup's states
// list): access denied, an access request still waiting, and the read error.
// Each replaces the tab body, never the shell and never the tabs — an operator
// keeps their bearings, and the switches tab stays reachable from the registry
// tab's error.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import { linkText, mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { routes } from "@/shared/safe-path";
import type { OrgRole } from "@/server/viewer";
import type { ToolsAt } from "./view";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function ToolsReadFailure({
  at,
  orgRole,
  read,
  retry,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  read: Failure;
  /** Where "Try again" points: the tab the read was made for. */
  retry: ReturnType<typeof routes.tools>;
}) {
  const t = useTranslations("tools.failure");
  const roles = useTranslations("tools.roles");
  switch (read.reason) {
    case "denied":
      return (
        <OutcomePanel
          tone="deny"
          testId="tools-denied"
          title={t("denied.title")}
          actions={
            <SafeLink to={routes.fleet(at.org, at.ws)} className={linkText}>
              {t("back")}
            </SafeLink>
          }
        >
          <span className="flex flex-col gap-2">
            <span>{t("denied.body")}</span>
            <span className="flex flex-col gap-0.5 text-left">
              <span>{t("denied.signedIn", { role: roles(orgRole) })}</span>
              <span>
                {t("denied.needed")}{" "}
                <span className={mono}>{read.permission}</span>
              </span>
              <span>{t("denied.decidedBy")}</span>
            </span>
          </span>
        </OutcomePanel>
      );
    case "pending_approval":
      return (
        <OutcomePanel
          tone="neutral"
          testId="tools-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </OutcomePanel>
      );
    case "error":
      return (
        <OutcomePanel
          tone="neutral"
          testId="tools-error"
          title={t("error.title")}
          actions={
            <SafeLink to={retry} className={linkText}>
              {t("error.retry")}
            </SafeLink>
          }
        >
          <span className="flex flex-col gap-1">
            <span>{t("error.body")}</span>
            <span className={mono}>
              {t("error.code", {
                status: String(read.status),
                code: read.code,
              })}
            </span>
          </span>
        </OutcomePanel>
      );
  }
}
