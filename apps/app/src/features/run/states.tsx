// The Run page's not-loaded states (pages/run.md, States; mockup
// `emptyState`, `errorState`, `deniedState`): each replaces the page body and
// never the shell, so the sidebar, the breadcrumbs and the search stay.
//
// The shape is the design's `.state-wrap`: a glyph tile, an h2, one paragraph
// and the actions, centred with no panel around them. The copy is the
// design's, with two lines changed to what the record holds: the error's trace
// line says the trace id and region were not recorded and prints the instant
// the read failed in UTC (a failed read carries neither, #3841), and the denied
// state's "Decided by" says the policy was not recorded (a refusal carries only
// the permission it needed).
import { CircleAlert, Lock, Radio } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunRow } from "@/data/contracts/runs";
import { OpenIncident, RequestAccess, TryAgain } from "@/features/fleet";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { LiveEmptyFollow } from "./live-empty-follow";

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

/** An instant as the design prints it on the trace line: `2026-09-11 09:16:04Z`. */
function utcInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/**
 * A run token was minted and the agent has not made its first model call. A
 * live run keeps reading, so the page turns into the run the moment its first
 * frame lands.
 */
export function RunEmpty({
  run,
  org,
  ws,
}: {
  run: RunRow;
  org: string;
  ws: string;
}) {
  const t = useTranslations("run.states.empty");
  return (
    <>
      <StateWrap
        testId="run-empty"
        icon={<Radio className="size-5" />}
        iconTone="neutral"
        title={t("title")}
        actions={
          <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
        }
      >
        {t("body")}
      </StateWrap>
      {run.status === "live" ? (
        <LiveEmptyFollow org={org} ws={ws} runId={run.id} />
      ) : null}
    </>
  );
}

export function RunError({
  code,
  status,
  ws,
  readAt,
}: {
  code: string;
  status: number;
  ws: string;
  /** Epoch milliseconds the read failed at. */
  readAt: number;
}) {
  const t = useTranslations("run.states.error");
  const at = utcInstant(readAt);
  return (
    <StateWrap
      testId="run-error"
      icon={<CircleAlert className="size-5" />}
      iconTone="failed"
      title={t("title")}
      actions={
        <>
          <TryAgain />
          <OpenIncident code={code} status={status} at={at} ws={ws} />
        </>
      }
      after={
        <p
          data-testid="run-error-trace"
          className={`${mono} mt-4 text-[11.5px] text-dim`}
        >
          <span data-recorded="false">{t("trace", { at })}</span>
        </p>
      }
    >
      {t.rich("body", { status: String(status), code, c: codeTag })}
    </StateWrap>
  );
}

export function RunDenied({
  permission,
  ctx,
}: {
  permission: string;
  ctx: WsCtx;
}) {
  const t = useTranslations("run.states.denied");
  const ws = ctx.wsSlug;
  return (
    <StateWrap
      testId="run-denied"
      icon={<Lock className="size-5" />}
      iconTone="denied"
      title={t("title")}
      actions={
        <>
          <RequestAccess permission={permission} ws={ws} />
          <SafeLink
            to={routes.fleet(ctx.orgSlug, ws)}
            className={buttonSecondary}
          >
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <dl className="mt-5 grid max-w-[420px] grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-[7px] text-left text-[12.5px]">
          <dt className="text-dim">{t("signedIn")}</dt>
          <dd>
            {t.rich("signedInValue", {
              wsRole: ctx.wsRole,
              ws,
              c: (chunks) => <span className={mono}>{chunks}</span>,
            })}
          </dd>
          <dt className="text-dim">{t("needed")}</dt>
          <dd className={mono}>{t("neededValue", { permission, ws })}</dd>
          <dt className="text-dim">{t("decidedBy")}</dt>
          <dd>{t("decidedByValue")}</dd>
        </dl>
      }
    >
      {t.rich("body", {
        org: ctx.orgName,
        permission,
        ws,
        b: (chunks) => <b className="text-foreground">{chunks}</b>,
        c: codeTag,
      })}
    </StateWrap>
  );
}

export function RunPending({ accessRequestId }: { accessRequestId: string }) {
  const t = useTranslations("run.states.pending");
  return (
    <StateWrap
      testId="run-pending"
      icon={<Lock className="size-5" />}
      iconTone="neutral"
      title={t("title")}
    >
      {t("body", { request: accessRequestId })}
    </StateWrap>
  );
}
