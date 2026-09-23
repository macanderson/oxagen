// The not-loaded states of the mandate page, in the design's words and shape
// (`errorState`, `deniedState` in the design's engine.js). Each replaces the
// page body and never the shell, so a reader who cannot see this mandate keeps
// the sidebar, the breadcrumbs and the search, and can leave.
//
// **Denied names the permission and not the person's shortcoming.** The read
// is `get_mandate`, and `PAGE_FAILURES.mandates` names `org.billing`, the
// finance role the design names. Request access and Open an incident have no
// write behind them yet, so each opens a dialog that says so (`StubDialog`)
// rather than pretending to file anything.
//
// **Error names what the read answered.** The code and status are the kernel
// seam's. The design's trace line also carries a trace id and a region; the
// read path returns neither, so the line names the instant the read failed and
// says the trace is not recorded.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import type { WsRole } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { StateWrap } from "./state";
import { StubDialog } from "./stub-dialog";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function MandateReadFailure({
  read,
  viewer,
  orgName,
  org,
  ws,
  retry,
  readAt,
}: {
  read: Failure;
  /** Who was refused: the session's name and the workspace role, for *Signed in as*. */
  viewer: { name: string | null; wsRole: WsRole };
  orgName: string;
  org: string;
  ws: string;
  /** Where Try again points: this same page. */
  retry: SafePath;
  /** The instant the read was attempted, formatted by the caller. */
  readAt: string;
}) {
  const t = useTranslations("mandate.failure");
  switch (read.reason) {
    case "denied":
      return (
        <StateWrap
          kind="denied"
          title={t("denied.title")}
          headingLevel={1}
          testId="mandate-denied"
          actions={
            <>
              <StubDialog
                primary
                label={t("denied.requestAccess")}
                title={t("denied.requestAccess")}
                body={t("denied.requestAccessBody", {
                  permission: read.permission,
                })}
                gap="access-request"
                testId="request-access"
              />
              <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
                {t("back")}
              </SafeLink>
            </>
          }
          below={
            <dl className="mt-5 grid max-w-[420px] grid-cols-[auto_1fr] gap-x-4 gap-y-[7px] text-left text-[12.5px]">
              <dt className="text-dim">{t("denied.signedIn")}</dt>
              <dd className="m-0" data-testid="signed-in-as">
                {viewer.name === null ? null : (
                  <>
                    {viewer.name}
                    {" · "}
                  </>
                )}
                <span className={mono}>{`workspace.${viewer.wsRole}`}</span>
                {" · "}
                <span className={mono}>{ws}</span>
              </dd>
              <dt className="text-dim">{t("denied.needed")}</dt>
              <dd className="m-0">
                <span className={mono}>{read.permission}</span>
              </dd>
              <dt className="text-dim">{t("denied.decidedBy")}</dt>
              <dd className="m-0">{t("denied.decidedByValue")}</dd>
            </dl>
          }
        >
          {t.rich("denied.body", {
            org: orgName,
            permission: read.permission,
            b: (chunks) => <b className="text-foreground">{chunks}</b>,
            code: (chunks) => <code className={mono}>{chunks}</code>,
          })}
        </StateWrap>
      );
    case "pending_approval":
      return (
        <OutcomePanel
          tone="neutral"
          testId="mandate-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </OutcomePanel>
      );
    case "error":
      return (
        <StateWrap
          kind="error"
          title={t("error.title")}
          headingLevel={1}
          testId="mandate-error"
          actions={
            <>
              <SafeLink to={retry} className={buttonPrimary}>
                {t("error.retry")}
              </SafeLink>
              <StubDialog
                label={t("error.incident")}
                title={t("error.incident")}
                body={t("error.incidentBody", {
                  status: String(read.status),
                  code: read.code,
                  at: readAt,
                })}
                gap="incident-write"
                testId="open-incident"
              />
            </>
          }
          below={
            <p
              data-testid="mandate-trace"
              className={`${mono} mt-4 text-[11.5px] text-dim`}
            >
              {t("error.trace", { at: readAt })}
            </p>
          }
        >
          {t.rich("error.body", {
            status: String(read.status),
            code: read.code,
            c: (chunks) => <code className={mono}>{chunks}</code>,
          })}
        </StateWrap>
      );
  }
}
