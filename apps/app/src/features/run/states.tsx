// The Run page's not-loaded states (pages/run.md, States; mockup
// `emptyState`, `errorState`, `deniedState`): each replaces the page body and
// never the shell, so the sidebar, the breadcrumbs and the search stay.
//
// The shape is the design's `.state-wrap`, drawn by the shared `StateWrap`: a
// glyph tile, an h2, one paragraph and the actions, centred with no panel
// around them. The copy is the design's, with two lines changed to what the
// record holds: the error's trace line says the trace id and region were not
// recorded and prints the instant the read failed in UTC (a failed read
// carries neither, #3841), and the denied state's "Decided by" says the policy
// was not recorded (a refusal carries only the permission it needed), in the
// same words the shared `PageDenied` uses.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunRow } from "@/data/contracts/runs";
import { OpenIncident, RequestAccess, TryAgain } from "@/features/fleet";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, kvTerm, kvValue, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateCode, stateFacts, stateTrace } from "@/ui/state-wrap";
import { LiveEmptyFollow } from "./live-empty-follow";

const codeTag = (chunks: ReactNode) => (
  <code className={stateCode}>{chunks}</code>
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
        tone="neutral"
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
      tone="failed"
      title={t("title")}
      actions={
        <>
          <TryAgain />
          <OpenIncident code={code} status={status} at={at} ws={ws} />
        </>
      }
      after={
        <p data-testid="run-error-trace" className={stateTrace}>
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
      tone="denied"
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
        <dl className={stateFacts}>
          <dt className={kvTerm}>{t("signedIn")}</dt>
          <dd className={kvValue}>
            {t.rich("signedInValue", {
              wsRole: ctx.wsRole,
              ws,
              c: (chunks) => <span className={mono}>{chunks}</span>,
            })}
          </dd>
          <dt className={kvTerm}>{t("needed")}</dt>
          <dd className={`${kvValue} ${mono}`}>
            {t("neededValue", { permission, ws })}
          </dd>
          <dt className={kvTerm}>{t("decidedBy")}</dt>
          <dd className={kvValue}>{t("decidedByValue")}</dd>
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
      tone="neutral"
      glyph="lock"
      title={t("title")}
    >
      {t("body", { request: accessRequestId })}
    </StateWrap>
  );
}
