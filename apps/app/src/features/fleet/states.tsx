// Fleet's not-loaded states (fleet.md, States): empty, error, access denied,
// and an access request still waiting. Each replaces the page body and never
// the shell, so the sidebar, the breadcrumbs and the search stay.
//
// The shape is the design's `.state-wrap`: a glyph tile, an h2, one paragraph
// and the actions, centred with no panel around them. The copy is the
// design's, with two lines changed to what the record holds: the error line
// prints the status, the code and the instant the read failed (a read carries
// no trace id or region), and the denied state's "Decided by" says the policy
// was not recorded (a refusal carries only the permission it needed).
import { Lock, Table2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";
import { OpenIncident, RequestAccess, TryAgain } from "./state-actions";

const tone = {
  neutral: "text-muted-foreground",
  failed: "text-error-ink border-error/40",
  denied: "text-warning border-warning/40",
} as const;

function StateWrap({
  testId,
  icon,
  iconTone,
  title,
  children,
  actions,
  after,
}: {
  testId: string;
  icon: ReactNode;
  iconTone: keyof typeof tone;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-labelledby={`${testId}-title`}
      className="grid place-items-center px-5 py-[60px] text-center"
    >
      <div
        aria-hidden="true"
        className={`mb-3.5 grid size-11 place-items-center rounded-xl border border-border bg-card ${tone[iconTone]}`}
      >
        {icon}
      </div>
      <h2 id={`${testId}-title`} className="mb-[7px] text-lg font-semibold">
        {title}
      </h2>
      <p className="mx-auto mb-4 max-w-[52ch] text-[13px] text-muted-foreground">
        {children}
      </p>
      {actions === undefined ? null : (
        <div className="flex flex-wrap justify-center gap-[9px]">{actions}</div>
      )}
      {after}
    </section>
  );
}

const codeTag = (chunks: ReactNode) => (
  <code className={`${mono} rounded bg-muted px-1`}>{chunks}</code>
);

export function FleetEmpty({
  workspace,
  org,
  ws,
}: {
  workspace: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("fleet.empty");
  return (
    <StateWrap
      testId="fleet-empty"
      icon={<Table2 className="size-5" />}
      iconTone="neutral"
      title={t("title", { workspace })}
      actions={
        <>
          <SafeLink
            to={routes.register(org, ws, "name")}
            className={buttonPrimary}
          >
            {t("register")}
          </SafeLink>
          <SafeLink to={routes.agents(org, ws)} className={buttonSecondary}>
            {t("agents")}
          </SafeLink>
        </>
      }
    >
      {t("body")}
    </StateWrap>
  );
}

export function FleetError({
  code: errorCode,
  status,
  readAt,
}: {
  code: string;
  status: number;
  /** Epoch milliseconds the read failed at. */
  readAt: number;
}) {
  const t = useTranslations("fleet.error");
  const format = useFormatter();
  const at = format.dateTime(new Date(readAt), {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  return (
    <StateWrap
      testId="fleet-error"
      icon={<TriangleAlert className="size-5" />}
      iconTone="failed"
      title={t("title")}
      actions={
        <>
          <TryAgain />
          <OpenIncident code={errorCode} status={status} at={at} />
        </>
      }
      after={
        <p
          data-testid="fleet-error-trace"
          className={`${mono} mt-4 text-[11.5px] text-dim`}
        >
          {t("trace", { status: String(status), code: errorCode, at })}
        </p>
      }
    >
      {t.rich("body", { code: errorCode, c: codeTag })}
    </StateWrap>
  );
}

export function FleetDenied({
  permission,
  orgName,
  orgRole,
  wsRole,
  org,
  ws,
}: {
  permission: string;
  orgName: string;
  orgRole: string;
  wsRole: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("fleet.denied");
  return (
    <StateWrap
      testId="fleet-denied"
      icon={<Lock className="size-5" />}
      iconTone="denied"
      title={t("title")}
      actions={
        <>
          <RequestAccess permission={permission} ws={ws} />
          <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <dl className="mt-5 grid max-w-[420px] grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-[7px] text-left text-[12.5px]">
          <dt className="text-dim">{t("signedIn")}</dt>
          <dd className={mono}>
            {t("signedInValue", { orgRole, wsRole, ws })}
          </dd>
          <dt className="text-dim">{t("needed")}</dt>
          <dd className={mono}>{t("neededValue", { permission, ws })}</dd>
          <dt className="text-dim">{t("decidedBy")}</dt>
          <dd>{t("decidedByValue")}</dd>
        </dl>
      }
    >
      {t.rich("body", {
        org: orgName,
        permission,
        ws,
        b: (chunks) => <b className="text-foreground">{chunks}</b>,
        c: codeTag,
      })}
    </StateWrap>
  );
}

export function FleetPending({ accessRequestId }: { accessRequestId: string }) {
  const t = useTranslations("fleet.pending");
  return (
    <StateWrap
      testId="fleet-pending"
      icon={<Lock className="size-5" />}
      iconTone="neutral"
      title={t("title")}
    >
      {t("body", { request: accessRequestId })}
    </StateWrap>
  );
}
