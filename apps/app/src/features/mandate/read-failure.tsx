// The not-loaded states of the mandate page, in the design's words and shape
// (`errorState`, `deniedState` in the design's engine.js). Each replaces the
// page body and never the shell, so a reader who cannot see this mandate keeps
// the sidebar, the breadcrumbs and the search, and can leave.
//
// **Decided by names what is not recorded.** The design prints the deciding
// policy's id; a refused read carries only the permission it needed (#3841,
// #3846), so the line says the policy is not recorded, then the rule that holds
// either way.
//
// **Denied names the permission and not the person's shortcoming.** The read
// is `get_mandate`, and `PAGE_FAILURES.mandates` names `org.billing`, the
// finance role the design names. Request access and Open an incident have no
// write behind them yet, so each opens the design's dialog with its send drawn
// disabled beside the sentence that says why (`stub-dialog.tsx`), rather than
// pretending to file anything.
//
// **Error names what the read answered.** The code and status are the kernel
// seam's. The design's trace line is `trace <id> · <region> · <instant>`; the
// read path returns no trace id and no region (#3847, #3841), so those two
// render as not recorded and the line keeps the instant the read failed, in
// the design's `YYYY-MM-DD HH:MM:SSZ`.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import type { WsRole } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { NotBacked, StateWrap } from "./state";
import { IncidentDialog, RequestAccessDialog } from "./stub-dialog";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function MandateReadFailure({
  read,
  viewer,
  orgName,
  org,
  ws,
  retry,
  mandate,
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
  /** The mandate id the route names. */
  mandate: string;
  /** The instant the read was attempted, as `YYYY-MM-DD HH:MM:SSZ`. */
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
              <RequestAccessDialog permission={read.permission} />
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
              <dd className="m-0">
                <NotBacked gap="deciding-policy">
                  {t("denied.policyNotRecorded")}
                </NotBacked>
                {" · "}
                {t("denied.denyWins")}
              </dd>
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
              <IncidentDialog
                status={read.status}
                code={read.code}
                mandate={mandate}
                at={readAt}
              />
            </>
          }
          below={
            <p
              data-testid="mandate-trace"
              className={`${mono} mt-4 text-[11.5px] text-dim`}
            >
              {t("error.trace")}{" "}
              <NotBacked gap="trace-id">
                {t("error.traceNotRecorded")}
              </NotBacked>
              {" · "}
              <NotBacked gap="region">{t("error.regionNotRecorded")}</NotBacked>
              {" · "}
              <time dateTime={readAt.replace(" ", "T")}>{readAt}</time>
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
