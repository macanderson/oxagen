// The three not-loaded states a Tools tab can be in (the mockup's states
// list): access denied, an access request still waiting, and the read error.
// Each replaces the tab body, never the shell and never the tabs, so an
// operator keeps their bearings, and the switches tab stays reachable from the
// registry tab's error. Each is the shared `StateWrap`, the design's
// `.state-wrap`, with no panel around it (#4048).
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateTrace } from "@/ui/state-wrap";
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
        <StateWrap
          tone="denied"
          testId="tools-denied"
          title={t("denied.title")}
          actions={
            <SafeLink
              to={routes.fleet(at.org, at.ws)}
              className={buttonSecondary}
            >
              {t("back")}
            </SafeLink>
          }
          after={
            <ul className="mx-auto mt-5 flex max-w-[420px] flex-col gap-[7px] text-left text-[12.5px] text-muted-foreground">
              <li>{t("denied.signedIn", { role: roles(orgRole) })}</li>
              <li>
                {t("denied.needed")}{" "}
                <span className={`${mono} text-foreground`}>
                  {read.permission}
                </span>
              </li>
              <li>{t("denied.decidedBy")}</li>
            </ul>
          }
        >
          {t("denied.body")}
        </StateWrap>
      );
    case "pending_approval":
      return (
        <StateWrap
          tone="neutral"
          glyph="lock"
          testId="tools-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          tone="failed"
          testId="tools-error"
          title={t("error.title")}
          actions={
            <SafeLink to={retry} className={buttonPrimary}>
              {t("error.retry")}
            </SafeLink>
          }
          after={
            <p className={stateTrace}>
              {t("error.code", {
                status: String(read.status),
                code: read.code,
              })}
            </p>
          }
        >
          {t("error.body")}
        </StateWrap>
      );
  }
}
