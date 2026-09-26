// Fleet's not-loaded states (fleet.md, States): empty, error, access denied,
// and an access request still waiting. Each replaces the page body and never
// the shell, so the sidebar, the breadcrumbs and the search stay.
//
// The shape is the design's `.state-wrap`, drawn by the shared `StateWrap`: a
// glyph tile, an h2, one paragraph and the actions, centred with no panel
// around them. The copy is the design's. The error's trace line prints the
// trace id, the region and the instant the read failed in UTC, and the denied
// state's "Decided by" names the rule that refused the read, each from what
// the kernel seam recorded (#3841). A fact the record does not hold reads
// "not recorded", and its span carries `data-recorded="false"`. The store
// keeps no versioned policies, so a rule id is printed as a rule, never as a
// policy.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { DecidedBy } from "@/data/read";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  kvTerm,
  kvValue,
  mono,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateCode, stateFacts, stateTrace } from "@/ui/state-wrap";
import { OpenIncident, RequestAccess, TryAgain } from "./state-actions";

const codeTag = (chunks: ReactNode) => (
  <code className={stateCode}>{chunks}</code>
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
      tone="neutral"
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
      after={
        // The CLI path to the same end (#2950): enrolling a machine records
        // the sessions of the agent that already runs on it.
        <p
          data-testid="fleet-empty-enroll"
          className="mx-auto mt-4 max-w-[52ch] text-[13px] text-muted-foreground"
        >
          {t.rich("enroll", { code: codeTag })}
        </p>
      }
    >
      {t("body")}
    </StateWrap>
  );
}

/** An instant as the design prints it on the trace line: `2026-09-11 09:16:04Z`. */
function utcInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

export function FleetError({
  code: errorCode,
  status,
  readAt,
  traceId = null,
  region = null,
  requestId,
  ws,
}: {
  code: string;
  status: number;
  /** Epoch milliseconds the read failed at. */
  readAt: number;
  /** The trace the read ran under; null or absent when none was recorded. */
  traceId?: string | null;
  /** The region that answered; null or absent when it was not recorded. */
  region?: string | null;
  /** The id the kernel seam gave the read; absent when it never reached the kernel. */
  requestId?: string;
  ws: string;
}) {
  const t = useTranslations("fleet.error");
  const at = utcInstant(readAt);
  return (
    <StateWrap
      testId="fleet-error"
      tone="failed"
      title={t("title")}
      actions={
        <>
          <TryAgain />
          <OpenIncident
            code={errorCode}
            status={status}
            at={at}
            traceId={traceId}
            requestId={requestId}
            ws={ws}
          />
        </>
      }
      after={
        <p data-testid="fleet-error-trace" className={stateTrace}>
          <span
            data-testid="fleet-error-trace-id"
            data-recorded={traceId === null ? "false" : "true"}
          >
            {traceId === null
              ? t("traceNotRecorded")
              : t("traceId", { id: traceId })}
          </span>
          {" · "}
          <span
            data-testid="fleet-error-region"
            data-recorded={region === null ? "false" : "true"}
          >
            {region ?? t("regionNotRecorded")}
          </span>
          {" · "}
          <span data-recorded="true">{at}</span>
          {requestId === undefined ? null : (
            <>
              {" · "}
              <span data-testid="fleet-error-request" data-recorded="true">
                {t("requestId", { id: requestId })}
              </span>
            </>
          )}
        </p>
      }
    >
      {t.rich("body", { status: String(status), code: errorCode, c: codeTag })}
    </StateWrap>
  );
}

/** The Decided by line: the rule the record names, or "not recorded". */
function DecidedByValue({ decidedBy }: { decidedBy: DecidedBy | null }) {
  const t = useTranslations("fleet.denied");
  if (decidedBy === null)
    return (
      <span data-testid="fleet-decided-by" data-recorded="false">
        {t("decidedByValue")}
      </span>
    );
  return (
    <span data-testid="fleet-decided-by" data-recorded="true">
      {t.rich(decidedBy.source === "iam" ? "decidedByIam" : "decidedByRule", {
        rule: decidedBy.id,
        c: (chunks) => <code className={mono}>{chunks}</code>,
      })}
    </span>
  );
}

export function FleetDenied({
  permission,
  decidedBy = null,
  orgName,
  viewerName,
  wsRole,
  org,
  ws,
}: {
  permission: string;
  /** The rule that refused the read; null or absent when none was recorded. */
  decidedBy?: DecidedBy | null;
  orgName: string;
  /** The signed-in person's name, or their email when they set no name. */
  viewerName: string;
  wsRole: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("fleet.denied");
  const byRule = decidedBy?.source === "decision_rule";
  return (
    <StateWrap
      testId="fleet-denied"
      tone="denied"
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
        <dl className={stateFacts}>
          <dt className={kvTerm}>{t("signedIn")}</dt>
          <dd className={kvValue}>
            {t.rich("signedInValue", {
              name: viewerName,
              wsRole,
              ws,
              c: (chunks) => <span className={mono}>{chunks}</span>,
            })}
          </dd>
          <dt className={kvTerm}>{t("needed")}</dt>
          <dd className={`${kvValue} ${mono}`}>
            {t("neededValue", { permission, ws })}
          </dd>
          <dt className={kvTerm}>{t("decidedBy")}</dt>
          <dd className={kvValue}>
            <DecidedByValue decidedBy={decidedBy} />
          </dd>
        </dl>
      }
    >
      {/* A decision rule refuses a person whose roles grant the read, so the
          body says a rule refused it rather than that a role is missing. */}
      {t.rich(byRule ? "bodyRule" : "body", {
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
      tone="neutral"
      glyph="lock"
      title={t("title")}
    >
      {t("body", { request: accessRequestId })}
    </StateWrap>
  );
}
