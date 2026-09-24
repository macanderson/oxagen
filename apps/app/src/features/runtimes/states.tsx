// The not-loaded states of the Runtimes pages (runtimes.md, States), each the
// mockup's `.state-wrap` (the shared `StateWrap`): an icon, a title, the
// sentences, the actions. Error, access denied and waiting-for-approval replace
// the page body, header included, and the shell around it stays. Empty keeps
// the header, because the header's Enroll a runtime is the way in. The icons are
// the mockup's: a framed panel for empty, a circled exclamation for error, a
// lock for denied.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, kvTerm, kvValue, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateCode, stateFacts, stateTrace } from "@/ui/state-wrap";
import { NotBacked } from "./parts";
import {
  CliPath,
  EnrollRuntime,
  OpenIncident,
  RequestAccess,
  TryAgain,
} from "./controls";

type Failure = Exclude<Read<unknown>, { ok: true }>;

/**
 * The trace line's instant, as the mockup prints it: `2026-09-11 09:16:04Z`,
 * UTC to the second. A person reads it aloud to whoever runs the workspace, so
 * it carries no `T` and no milliseconds.
 */
function traceStamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Empty: no enrollment is recorded in this workspace. */
export function RuntimesEmpty({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("runtimes.empty");
  return (
    <StateWrap
      tone="neutral"
      title={t("title")}
      testId="runtimes-empty"
      actions={
        <>
          <EnrollRuntime org={org} ws={ws} />
          <CliPath />
        </>
      }
    >
      {t.rich("body", {
        code: (chunks) => <code className={stateCode}>{chunks}</code>,
      })}
    </StateWrap>
  );
}

/**
 * A read that did not return a value. `denied` names the permission the page
 * needs on this workspace; `error` names the code the control plane answered
 * and when the read was made, the trace line a person can report.
 */
export function RuntimesFailure({
  read,
  org,
  ws,
  orgName,
  wsSlug,
  wsRole,
  viewerName,
  readAt,
}: {
  read: Failure;
  org: string;
  ws: string;
  orgName: string;
  wsSlug: string;
  /** The viewer's role in this workspace: Signed in as names it, as the mockup's `me().role` does. */
  wsRole: string;
  /** The signed-in person's name, or their email when the account has no name. */
  viewerName: string;
  /** The instant the read returned, in epoch milliseconds. */
  readAt: number;
}) {
  const t = useTranslations("runtimes");
  switch (read.reason) {
    case "denied":
      return (
        <StateWrap
          tone="denied"
          title={t("denied.title")}
          testId="runtimes-denied"
          actions={
            <>
              <RequestAccess
                org={org}
                permission={t("denied.neededValue", {
                  permission: read.permission,
                  workspace: wsSlug,
                })}
              />
              <SafeLink
                to={routes.fleet(org, ws)}
                data-touch-target=""
                className={buttonSecondary}
              >
                {t("denied.back")}
              </SafeLink>
            </>
          }
          after={
            <dl className={stateFacts}>
              <dt className={kvTerm}>{t("denied.signedIn")}</dt>
              <dd data-testid="runtimes-signed-in" className={kvValue}>
                {t.rich("denied.signedInValue", {
                  name: viewerName,
                  wsRole,
                  workspace: wsSlug,
                  code: (chunks) => <code className={mono}>{chunks}</code>,
                })}
              </dd>
              <dt className={kvTerm}>{t("denied.needed")}</dt>
              <dd className={`${kvValue} ${mono}`}>
                {t("denied.neededValue", {
                  permission: read.permission,
                  workspace: wsSlug,
                })}
              </dd>
              <dt className={kvTerm}>{t("denied.decidedBy")}</dt>
              <dd data-testid="runtimes-decided-by" className={kvValue}>
                {t.rich("denied.decidedByValue", {
                  policy: () => (
                    <NotBacked gap="decision">
                      {t("denied.policyUnrecorded")}
                    </NotBacked>
                  ),
                })}
              </dd>
            </dl>
          }
        >
          {t.rich("denied.body", {
            org: orgName,
            permission: t("denied.neededValue", {
              permission: read.permission,
              workspace: wsSlug,
            }),
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
          title={t("pending.title")}
          testId="runtimes-pending"
        >
          <span className={mono}>
            {t("pending.body", { request: read.accessRequestId })}
          </span>
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          tone="failed"
          title={t("error.title")}
          testId="runtimes-error"
          actions={
            <>
              <TryAgain />
              <OpenIncident code={read.code} />
            </>
          }
          after={
            <p data-testid="runtimes-trace" className={stateTrace}>
              {t.rich("error.trace", {
                at: traceStamp(readAt),
                trace: () => <NotBacked gap="decision" />,
                region: () => (
                  <NotBacked gap="decision">
                    {t("error.regionUnrecorded")}
                  </NotBacked>
                ),
              })}
            </p>
          }
        >
          {t.rich("error.body", {
            code: `${String(read.status)} ${read.code}`,
            c: (chunks) => <code className={stateCode}>{chunks}</code>,
          })}
        </StateWrap>
      );
  }
}
