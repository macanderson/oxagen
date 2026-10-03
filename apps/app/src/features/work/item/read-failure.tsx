// The not-loaded states of the Work item page: the read was denied, waits for
// an access request, or failed. Each replaces the page body and never the
// shell, so a person who cannot read the item keeps the sidebar and can leave.
// A denial names the permission the read needed, so the person knows what to
// ask for. A failure names the code the read path answered and when, so it can
// be reported. An item the workspace does not hold is a 404 instead
// (work-item-page.tsx).
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateTrace } from "@/ui/state-wrap";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function WorkItemReadFailure({
  read,
  org,
  ws,
  retry,
  readAt,
}: {
  read: Failure;
  org: string;
  ws: string;
  /** Where Try again points: this same page. */
  retry: SafePath;
  /** When the read was attempted, already formatted. */
  readAt: string;
}) {
  const t = useTranslations("workItem.read");
  const back = (
    <SafeLink to={routes.work(org, ws)} className={buttonSecondary}>
      {t("back")}
    </SafeLink>
  );
  switch (read.reason) {
    case "denied":
      return (
        <StateWrap
          tone="denied"
          testId="work-item-denied"
          title={t("deniedTitle")}
          actions={back}
          after={
            <p className="mx-auto mt-5 max-w-105 text-sm text-muted-foreground">
              {t("needed")}{" "}
              <span className={`${mono} text-foreground`}>{read.permission}</span>
            </p>
          }
        >
          {t("deniedBody")}
        </StateWrap>
      );
    case "pending_approval":
      return (
        <StateWrap
          tone="neutral"
          glyph="lock"
          testId="work-item-pending"
          title={t("pendingTitle")}
          actions={back}
        >
          {t("pendingBody", { request: read.accessRequestId })}
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          tone="failed"
          testId="work-item-error"
          title={t("errorTitle")}
          actions={
            <>
              {back}
              <SafeLink to={retry} className={buttonPrimary}>
                {t("retry")}
              </SafeLink>
            </>
          }
          after={
            <p className={stateTrace}>
              {t("code", { status: String(read.status), code: read.code })}
              <br />
              {t("readAt", { at: readAt })}
            </p>
          }
        >
          {t("errorBody")}
        </StateWrap>
      );
  }
}
