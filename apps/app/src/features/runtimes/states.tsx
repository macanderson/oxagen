// The not-loaded states of the Runtimes pages (runtimes.md, States), each the
// mockup's `.state-wrap`: an icon, a title, the sentences, the actions. Error,
// access denied and waiting-for-approval replace the page body, header
// included; the shell around it stays. Empty keeps the header, because the
// header's Enroll a runtime is the way in.
import { Inbox, Lock, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { OrgRole } from "@/data/contracts/common";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import {
  CliPath,
  EnrollRuntime,
  OpenIncident,
  RequestAccess,
  TryAgain,
} from "./controls";

type Failure = Exclude<Read<unknown>, { ok: true }>;

function StateWrap({
  tone,
  title,
  testId,
  children,
}: {
  tone: "neutral" | "failed" | "denied";
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const Icon =
    tone === "failed" ? TriangleAlert : tone === "denied" ? Lock : Inbox;
  const ring =
    tone === "failed"
      ? "border-error/40 text-error-ink"
      : tone === "denied"
        ? "border-warning/40 text-warning"
        : "border-border text-foreground";
  return (
    <section
      data-testid={testId}
      aria-labelledby={`${testId}-title`}
      className="mx-auto flex max-w-[480px] flex-col items-center px-4 py-14 text-center"
    >
      <span
        aria-hidden="true"
        className={`mb-3.5 inline-flex size-11 items-center justify-center rounded-xl border bg-card ${ring}`}
      >
        <Icon className="size-5" />
      </span>
      <h2
        id={`${testId}-title`}
        className="text-lg font-semibold text-foreground"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const body = "mt-1.5 text-[13px] text-muted-foreground";
const code = `${mono} rounded bg-muted px-1`;

/** Empty: no enrollment is recorded in this workspace. */
export function RuntimesEmpty({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("runtimes.empty");
  return (
    <StateWrap tone="neutral" title={t("title")} testId="runtimes-empty">
      <p className={body}>
        {t.rich("body", {
          code: (chunks) => <code className={code}>{chunks}</code>,
        })}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <EnrollRuntime org={org} ws={ws} />
        <CliPath />
      </div>
    </StateWrap>
  );
}

/**
 * A read that did not return a value. `denied` names the permission the page
 * needs on this workspace; `error` names the code the control plane answered
 * and when the read was made, the trace line a person can report.
 */
export function RuntimesFailure({
  read,
  org,
  ws,
  orgName,
  wsSlug,
  orgRole,
  wsRole,
  readAt,
}: {
  read: Failure;
  org: string;
  ws: string;
  orgName: string;
  wsSlug: string;
  orgRole: OrgRole;
  wsRole: string;
  /** The instant the read returned, formatted by the caller. */
  readAt: string;
}) {
  const t = useTranslations("runtimes");
  switch (read.reason) {
    case "denied":
      return (
        <StateWrap
          tone="denied"
          title={t("denied.title")}
          testId="runtimes-denied"
        >
          <p className={body}>
            {t.rich("denied.body", {
              org: orgName,
              permission: t("denied.neededValue", {
                permission: read.permission,
                workspace: wsSlug,
              }),
              b: (chunks) => (
                <b className="font-semibold text-foreground">{chunks}</b>
              ),
              code: (chunks) => <code className={code}>{chunks}</code>,
            })}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <RequestAccess
              org={org}
              permission={t("denied.neededValue", {
                permission: read.permission,
                workspace: wsSlug,
              })}
            />
            <SafeLink
              to={routes.fleet(org, ws)}
              data-touch-target=""
              className={buttonSecondary}
            >
              {t("denied.back")}
            </SafeLink>
          </div>
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left text-[13px]">
            <dt className="text-muted-foreground">{t("denied.signedIn")}</dt>
            <dd>{t("denied.signedInValue", { orgRole, wsRole })}</dd>
            <dt className="text-muted-foreground">{t("denied.needed")}</dt>
            <dd className={mono}>
              {t("denied.neededValue", {
                permission: read.permission,
                workspace: wsSlug,
              })}
            </dd>
            <dt className="text-muted-foreground">{t("denied.decidedBy")}</dt>
            <dd>{t("denied.decidedByValue")}</dd>
          </dl>
        </StateWrap>
      );
    case "pending_approval":
      return (
        <StateWrap
          tone="neutral"
          title={t("pending.title")}
          testId="runtimes-pending"
        >
          <p className={`${body} ${mono}`}>
            {t("pending.body", { request: read.accessRequestId })}
          </p>
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          tone="failed"
          title={t("error.title")}
          testId="runtimes-error"
        >
          <p className={body}>
            {t.rich("error.body", {
              code: read.code,
              c: (chunks) => <code className={code}>{chunks}</code>,
            })}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <TryAgain />
            <OpenIncident code={read.code} />
          </div>
          <p
            data-testid="runtimes-trace"
            className={`${mono} mt-4 text-[11.5px] text-dim`}
          >
            {t("error.trace", {
              status: String(read.status),
              code: read.code,
              at: readAt,
            })}
          </p>
        </StateWrap>
      );
  }
}
