// The not-loaded states of the Runtimes pages (runtimes.md, States), each the
// mockup's `.state-wrap`: an icon, a title, the sentences, the actions. Error,
// access denied and waiting-for-approval replace the page body, header
// included; the shell around it stays. Empty keeps the header, because the
// header's Enroll a runtime is the way in. The icons are the mockup's: a
// framed panel for empty, a circled exclamation for error, a lock for denied.
import { CircleAlert, Lock, PanelTop } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { NotBacked } from "./parts";
import {
  CliPath,
  EnrollRuntime,
  OpenIncident,
  RequestAccess,
  TryAgain,
} from "./controls";

type Failure = Exclude<Read<unknown>, { ok: true }>;

/**
 * The trace line's instant, as the mockup prints it: `2026-09-11 09:16:04Z`,
 * UTC to the second. A person reads it aloud to whoever runs the workspace, so
 * it carries no `T` and no milliseconds.
 */
export function traceStamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

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
    tone === "failed" ? CircleAlert : tone === "denied" ? Lock : PanelTop;
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
  wsRole,
  viewerName,
  readAt,
}: {
  read: Failure;
  org: string;
  ws: string;
  orgName: string;
  wsSlug: string;
  /** The viewer's role in this workspace: Signed in as names it, as the mockup's `me().role` does. */
  wsRole: string;
  /** The signed-in person's name, or their email when the account has no name. */
  viewerName: string;
  /** The instant the read returned, in epoch milliseconds. */
  readAt: number;
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
            <dd data-testid="runtimes-signed-in">
              {t.rich("denied.signedInValue", {
                name: viewerName,
                wsRole,
                workspace: wsSlug,
                code: (chunks) => <code className={mono}>{chunks}</code>,
              })}
            </dd>
            <dt className="text-muted-foreground">{t("denied.needed")}</dt>
            <dd className={mono}>
              {t("denied.neededValue", {
                permission: read.permission,
                workspace: wsSlug,
              })}
            </dd>
            <dt className="text-muted-foreground">{t("denied.decidedBy")}</dt>
            <dd data-testid="runtimes-decided-by">
              {t.rich("denied.decidedByValue", {
                policy: () => (
                  <NotBacked gap="decision">
                    {t("denied.policyUnrecorded")}
                  </NotBacked>
                ),
              })}
            </dd>
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
              code: `${String(read.status)} ${read.code}`,
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
            {t.rich("error.trace", {
              at: traceStamp(readAt),
              trace: () => <NotBacked gap="decision" />,
              region: () => (
                <NotBacked gap="decision">
                  {t("error.regionUnrecorded")}
                </NotBacked>
              ),
            })}
          </p>
        </StateWrap>
      );
  }
}
