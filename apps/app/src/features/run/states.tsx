// The Run page's not-loaded states (spec pages/run.md, States): a run with no
// frames yet, a read that failed, and a viewer the read refused. Each replaces
// the page BODY and never the shell, so the sidebar, the breadcrumbs and the
// search stay and a person keeps their bearings.
//
// The copy is the spec's, verbatim. Two controls the spec draws are not here
// and neither is stubbed: Request access and Open an incident each need a write
// no contract carries (no capability lets a person ask for a role or file an
// incident). A button that silently did nothing would be worse than none, so
// the denied state names the permission and who can grant it, and the error
// state names its code and the instant it was read so it can be reported.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import type { OrgRole, WsRole } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";

type Failure = Exclude<Read<unknown>, { ok: true }>;

type Place = { org: string; ws: string };

function BackToFleet({ org, ws }: Place) {
  const t = useTranslations("run.state");
  return (
    <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
      {t("back")}
    </SafeLink>
  );
}

/** A run token was minted and nothing has been recorded under it yet. */
export function RunEmpty({ org, ws }: Place) {
  const t = useTranslations("run.state.empty");
  return (
    <OutcomePanel
      tone="neutral"
      testId="run-empty"
      title={t("title")}
      actions={<BackToFleet org={org} ws={ws} />}
    >
      {t("body")}
    </OutcomePanel>
  );
}

export function RunReadFailure({
  read,
  org,
  ws,
  orgName,
  wsSlug,
  orgRole,
  wsRole,
  retry,
  readAt,
}: Place & {
  read: Failure;
  orgName: string;
  wsSlug: string;
  orgRole: OrgRole;
  wsRole: WsRole;
  /** Where Try again points: this same page. */
  retry: SafePath;
  /**
   * The instant the read answered, in epoch milliseconds. It is taken beside
   * the read rather than here, because a component may not read a clock
   * during render and the useful instant is the one the read failed at.
   */
  readAt: number;
}) {
  const t = useTranslations("run.state");
  const format = useFormatter();
  switch (read.reason) {
    case "denied": {
      const needed = t("denied.needed", {
        permission: read.permission,
        ws: wsSlug,
      });
      return (
        <OutcomePanel
          tone="deny"
          testId="run-denied"
          title={t("denied.title")}
          actions={<BackToFleet org={org} ws={ws} />}
        >
          <span className="flex flex-col gap-3">
            <span>
              {t.rich("denied.body", {
                org: orgName,
                needed,
                strong: (chunks) => (
                  <strong className="font-semibold text-foreground">
                    {chunks}
                  </strong>
                ),
                code: (chunks) => <code className={mono}>{chunks}</code>,
              })}
            </span>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left text-xs">
              <dt className="text-dim">{t("denied.signedIn")}</dt>
              <dd>
                {t("denied.roles", {
                  org: t(`role.${orgRole}`),
                  ws: t(`role.${wsRole}`),
                  slug: wsSlug,
                })}
              </dd>
              <dt className="text-dim">{t("denied.neededLabel")}</dt>
              <dd className={mono}>{needed}</dd>
              <dt className="text-dim">{t("denied.decidedByLabel")}</dt>
              <dd>{t("denied.decidedBy")}</dd>
            </dl>
          </span>
        </OutcomePanel>
      );
    }
    case "pending_approval":
      return (
        <OutcomePanel
          tone="neutral"
          testId="run-pending"
          title={t("pending.title")}
          actions={<BackToFleet org={org} ws={ws} />}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </OutcomePanel>
      );
    case "error":
      return (
        <OutcomePanel
          tone="neutral"
          testId="run-error"
          title={t("error.title")}
          actions={
            <SafeLink to={retry} className={buttonPrimary}>
              {t("error.retry")}
            </SafeLink>
          }
        >
          <span className="flex flex-col gap-3">
            <span>
              {t.rich("error.body", {
                answer: `${String(read.status)} ${read.code}`,
                code: (chunks) => <code className={mono}>{chunks}</code>,
              })}
            </span>
            <span className={`${mono} text-xs`}>
              {t("error.readAt", {
                at: format.dateTime(new Date(readAt), {
                  dateStyle: "medium",
                  timeStyle: "medium",
                }),
              })}
            </span>
          </span>
        </OutcomePanel>
      );
  }
}
