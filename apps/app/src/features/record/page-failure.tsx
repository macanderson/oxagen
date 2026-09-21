// The three not-loaded states of the record page (#3395). Each replaces the
// page BODY and never the shell: the sidebar, the breadcrumbs and the search
// stay, so a reader who cannot see this record keeps their bearings.
//
// There is no empty state here. The route names one record, so a lineage
// nothing holds is a 404, which `Record` raises before this component is
// reached.
//
// Two controls the mockup names are not drawn, and neither is stubbed.
// *Request access* would ask for a role: no contract in this codebase lets a
// person ask for one, and the kernel mints an access request only when a
// capability parks for approval, which is the `pending_approval` state below.
// *Open an incident* would file one: no contract does that either. The copy
// names the route that does exist instead, and prints the code and the
// instant so the failure can be reported by hand.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function PageFailure({
  read,
  org,
  ws,
  retry,
  readAt,
}: {
  read: Failure;
  org: string;
  ws: string;
  /** Where Try again points: this same record. */
  retry: SafePath;
  /**
   * The instant the read was attempted, formatted by the caller. A component
   * may not read a clock during render, and the useful instant is the one the
   * read failed at rather than the one this element rendered at.
   */
  readAt: string;
}) {
  const t = useTranslations("record.failure");
  switch (read.reason) {
    case "denied":
      return (
        <OutcomePanel
          tone="deny"
          testId="record-denied"
          title={t("denied.title")}
          actions={
            <SafeLink
              to={routes.steering(org, ws, { tab: "records" })}
              className={linkText}
            >
              {t("denied.back")}
            </SafeLink>
          }
        >
          <span className="flex flex-col gap-2">
            <span>{t("denied.body")}</span>
            <span className="flex flex-col gap-0.5 text-left">
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
          testId="record-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </OutcomePanel>
      );
    case "error":
      return (
        <OutcomePanel
          tone="neutral"
          testId="record-error"
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
            <span className={mono}>{t("error.readAt", { at: readAt })}</span>
          </span>
        </OutcomePanel>
      );
  }
}
