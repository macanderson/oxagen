// The Tools page's not-loaded states (mockup `tools.md`, States): empty, error,
// access denied, and the access request still waiting. Each replaces the page
// body, header and tabs included, and never the shell, so a person keeps the
// sidebar, the breadcrumbs and the search.
//
// Two controls the design names have no write behind them yet: Request access
// and Open an incident. Each opens the dialog the design names, which says
// what it would do and that nothing records it yet (#3820, #3847). A control
// that silently did nothing would be worse on a page about who may call what.
//
// Each is the shared `StateWrap`, the design's `.state-wrap`: a glyph tile, a
// heading, one paragraph and the actions, with no panel around them.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  kvTerm,
  kvValue,
  mono,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateCode, stateFacts } from "@/ui/state-wrap";
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
    <StateWrap
      tone="neutral"
      testId="tools-empty"
      title={t("title")}
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
        code: (chunks) => <code className={stateCode}>{chunks}</code>,
      })}
    </StateWrap>
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
        <StateWrap
          tone="denied"
          testId="tools-denied"
          title={t("denied.title")}
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
          after={
            <dl className={stateFacts}>
              <dt className={kvTerm}>{t("denied.signedIn")}</dt>
              <dd className={kvValue}>
                {roles(ctx.orgRole)} ·{" "}
                <span className={mono}>{ctx.wsSlug}</span>
              </dd>
              <dt className={kvTerm}>{t("denied.needed")}</dt>
              <dd className={`${kvValue} ${mono}`}>
                {t("denied.neededValue", {
                  permission: read.permission,
                  workspace: ctx.wsSlug,
                })}
              </dd>
              <dt className={kvTerm}>{t("denied.decidedBy")}</dt>
              <dd className={kvValue}>{t("denied.decidedByValue")}</dd>
            </dl>
          }
        >
          {t.rich("denied.body", {
            org: ctx.orgName,
            permission: read.permission,
            workspace: ctx.wsSlug,
            b: (chunks) => (
              <b className="font-semibold text-foreground">{chunks}</b>
            ),
            code: (chunks) => <code className={stateCode}>{chunks}</code>,
          })}
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
            mono: (chunks) => <code className={stateCode}>{chunks}</code>,
          })}
        </StateWrap>
      );
  }
}
