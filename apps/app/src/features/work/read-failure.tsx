// The not-loaded states of the Work page, Work setup and Outcomes: a refused
// read, an access request still waiting, and a read that failed. Each takes
// the place of the body under the page's header, and the header and the
// shell stay, so a person who cannot see the work records keeps their
// bearings. The work records take `run.read` (PAGE_FAILURES.work), and a
// refusal names the permission the read path reported.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateTrace } from "@/ui/state-wrap";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function WorkReadFailure({
  read,
  page,
  retry,
}: {
  read: Failure;
  /** The translated name of what failed to load: the page or the tab. */
  page: string;
  /** Where Try again points: the same page and tab. */
  retry: SafePath;
}) {
  const t = useTranslations("work.state");
  switch (read.reason) {
    case "denied":
      return (
        <StateWrap
          tone="denied"
          testId="work-denied"
          data-reason="denied"
          title={t("deniedTitle", { page })}
        >
          {t("deniedBody", { permission: read.permission })}
        </StateWrap>
      );
    case "pending_approval":
      return (
        <StateWrap
          tone="neutral"
          glyph="lock"
          testId="work-pending"
          data-reason="pending_approval"
          title={t("pendingTitle")}
        >
          {t("pendingBody", { request: read.accessRequestId })}
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          tone="failed"
          testId="work-error"
          data-reason="error"
          title={t("errorTitle", { page })}
          actions={
            <SafeLink to={retry} className={buttonPrimary}>
              {t("retry")}
            </SafeLink>
          }
          after={
            <p className={stateTrace}>
              {t("errorCode", { status: String(read.status), code: read.code })}
            </p>
          }
        >
          {t("errorBody")}
        </StateWrap>
      );
  }
}
