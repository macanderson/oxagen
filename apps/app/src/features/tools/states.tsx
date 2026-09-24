// The Tools page's not-loaded states (mockup `tools.md`, States): empty, error,
// access denied, and the access request still waiting. Each replaces the page
// body, header and tabs included, and never the shell, so a person keeps the
// sidebar, the breadcrumbs and the search.
//
// Two controls the design names have no write behind them yet: Request access
// and Open an incident. Each opens the dialog the design names, which says
// what it would do and that nothing records it yet (#3820, #3847). A control
// that silently did nothing would be worse on a page about who may call what.
import { Box, CircleAlert, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { AddConnection } from "./add-connection";
import { ImportProvider } from "./import-provider";
import { StubAction, StubField } from "./stub-action";
import { type ToolsAt, type ToolsTab, toolsLink } from "./view";

type Failure = Exclude<Read<unknown>, { ok: true }>;

/** No provider is registered and the registry holds no version. */
export function ToolsEmpty({
  at,
  canImport,
}: {
  at: ToolsAt;
  /** An org Owner or Admin: who `register_mcp_server` and `create_connection` admit. */
  canImport: boolean;
}) {
  const t = useTranslations("tools.empty");
  return (
    <OutcomePanel
      tone="neutral"
      testId="tools-empty"
      title={t("title")}
      icon={<Box aria-hidden className="size-5" />}
      actions={
        canImport ? (
          <>
            <ImportProvider at={at} servers={[]} primary />
            <AddConnection at={at} connectors={[]} primary={false} />
          </>
        ) : undefined
      }
    >
      {t.rich("body", {
        code: (chunks) => <span className={mono}>{chunks}</span>,
      })}
    </OutcomePanel>
  );
}

/** The registry read was refused, is waiting for approval, or failed. */
export function ToolsPageFailure({
  ctx,
  at,
  tab,
  read,
}: {
  ctx: WsCtx;
  at: ToolsAt;
  tab: ToolsTab;
  read: Failure;
}) {
  const t = useTranslations("tools.state");
  const roles = useTranslations("tools.roles");
  switch (read.reason) {
    case "denied":
      return (
        <OutcomePanel
          tone="deny"
          testId="tools-denied"
          title={t("denied.title")}
          icon={<Lock aria-hidden className="size-5" />}
          actions={
            <>
              <StubAction
                label={t("denied.request")}
                tone="primary"
                title={t("requestAccess.title")}
                gap="requestAccess"
                note={t("requestAccess.note")}
                confirm={t("requestAccess.confirm")}
                testId="tools-request-access"
              >
                <StubField
                  id="request-role"
                  label={t("requestAccess.role")}
                  placeholder={t("requestAccess.rolePlaceholder", {
                    permission: read.permission,
                    workspace: ctx.wsSlug,
                  })}
                />
                <StubField id="request-why" label={t("requestAccess.why")} />
              </StubAction>
              <SafeLink
                to={routes.fleet(at.org, at.ws)}
                className={buttonSecondary}
              >
                {t("back")}
              </SafeLink>
            </>
          }
        >
          <span className="flex flex-col gap-4">
            <span>
              {t.rich("denied.body", {
                org: ctx.orgName,
                permission: read.permission,
                workspace: ctx.wsSlug,
                b: (chunks) => (
                  <b className="font-semibold text-foreground">{chunks}</b>
                ),
                code: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </span>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-left text-[13px]">
              <dt className="text-muted-foreground">{t("denied.signedIn")}</dt>
              <dd className="text-foreground">
                {roles(ctx.orgRole)} ·{" "}
                <span className={mono}>{ctx.wsSlug}</span>
              </dd>
              <dt className="text-muted-foreground">{t("denied.needed")}</dt>
              <dd className={`${mono} text-foreground`}>
                {t("denied.neededValue", {
                  permission: read.permission,
                  workspace: ctx.wsSlug,
                })}
              </dd>
              <dt className="text-muted-foreground">{t("denied.decidedBy")}</dt>
              <dd className="text-foreground">{t("denied.decidedByValue")}</dd>
            </dl>
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
          tone="deny"
          testId="tools-error"
          title={t("error.title")}
          icon={<CircleAlert aria-hidden className="size-5" />}
          actions={
            <>
              <SafeLink to={toolsLink(at, { tab })} className={buttonPrimary}>
                {t("error.retry")}
              </SafeLink>
              <StubAction
                label={t("error.incident")}
                title={t("incident.title")}
                gap="incident"
                note={t("incident.note")}
                confirm={t("incident.confirm")}
                testId="tools-incident"
              >
                <StubField
                  id="incident-subject"
                  label={t("incident.subject")}
                  placeholder={t("incident.subjectPlaceholder", {
                    code: read.code,
                  })}
                />
                <StubField
                  id="incident-severity"
                  label={t("incident.severity")}
                  options={[
                    t("incident.severities.critical"),
                    t("incident.severities.warning"),
                    t("incident.severities.info"),
                  ]}
                />
              </StubAction>
            </>
          }
        >
          {t.rich("error.body", {
            status: String(read.status),
            code: read.code,
            mono: (chunks) => <span className={mono}>{chunks}</span>,
          })}
        </OutcomePanel>
      );
  }
}
