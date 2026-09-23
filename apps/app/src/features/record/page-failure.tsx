// The not-loaded states of the record page (#3395; mockups/pages/record.md,
// "States"; mockup `errorState`, `deniedState`). Each replaces the page BODY
// and never the shell: the sidebar, the breadcrumbs and the search stay, so a
// reader who cannot see this record keeps their bearings.
//
// There is no empty state. The route names one record, so a lineage nothing
// holds is a 404, which `Record` raises before this component is reached.
//
// *Request access* and *Open an incident* are drawn, disabled, with the line
// that says what they would do: no contract lets a person ask for a role
// (#3820) or open an incident from a page (#3847), and a button that silently
// does nothing is worse than one that says why it cannot.
import { CircleAlert, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { RECORD_GAPS } from "./gaps";

type Failure = Exclude<Read<unknown>, { ok: true }>;

const code = (chunks: ReactNode) => (
  <code className="rounded bg-hl px-1 font-mono text-[0.92em] text-foreground">
    {chunks}
  </code>
);
const strong = (chunks: ReactNode) => (
  <b className="font-semibold text-foreground">{chunks}</b>
);

/** `.state-wrap`: the icon tile, the heading, one paragraph, the actions. */
export function StateWrap({
  testId,
  icon,
  tone,
  title,
  children,
  actions,
  after,
}: {
  testId: string;
  icon: ReactNode;
  tone: "failed" | "denied" | "quiet";
  title: string;
  children: ReactNode;
  actions: ReactNode;
  after?: ReactNode;
}) {
  const ring = {
    failed: "text-error border-error/40",
    denied: "text-warning border-warning/40",
    quiet: "text-muted-foreground border-border",
  }[tone];
  return (
    <section
      role={tone === "failed" ? "alert" : undefined}
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      className="grid place-items-center px-5 py-[60px] text-center"
    >
      <div
        aria-hidden="true"
        className={`mb-3.5 grid size-11 place-items-center rounded-xl border bg-card ${ring}`}
      >
        {icon}
      </div>
      <h2
        id={`${testId}-title`}
        className="mb-[7px] text-lg font-semibold text-foreground"
      >
        {title}
      </h2>
      <p className="mx-auto mb-4 max-w-[52ch] text-[13px] leading-relaxed text-muted-foreground">
        {children}
      </p>
      <div className="flex flex-wrap justify-center gap-[9px] max-sm:w-full max-sm:flex-col">
        {actions}
      </div>
      {after}
    </section>
  );
}

export function PageFailure({
  read,
  org,
  orgName,
  ws,
  viewer,
  retry,
  readAt,
}: {
  read: Failure;
  org: string;
  orgName: string;
  ws: string;
  /** Who is signed in and in what role, for the denied state's first line. */
  viewer: { name: string; role: string };
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
    case "denied": {
      const needed = t("denied.needed", { permission: read.permission, ws });
      return (
        <StateWrap
          testId="record-denied"
          tone="denied"
          icon={<Lock className="size-5" />}
          title={t("denied.title")}
          actions={
            <>
              <button
                type="button"
                disabled
                aria-describedby="record-denied-request"
                data-gap={RECORD_GAPS.requestAccess}
                className={buttonPrimary}
              >
                {t("denied.request")}
              </button>
              <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
                {t("denied.back")}
              </SafeLink>
            </>
          }
          after={
            <>
              <p
                id="record-denied-request"
                data-state="not-recorded"
                className="mt-3 max-w-[52ch] text-xs text-dim"
              >
                {t("denied.requestNotRecorded", { needed })}
              </p>
              <dl className="mt-5 grid max-w-[420px] grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-left text-[13px] [&>dd]:text-foreground [&>dt]:text-muted-foreground">
                <dt>{t("denied.signedInTerm")}</dt>
                <dd>
                  {t.rich("denied.signedIn", {
                    name: viewer.name,
                    role: viewer.role,
                    code: (chunks) => <span className={mono}>{chunks}</span>,
                  })}
                </dd>
                <dt>{t("denied.neededTerm")}</dt>
                <dd className={mono}>{needed}</dd>
                <dt>{t("denied.decidedByTerm")}</dt>
                <dd>{t("denied.decidedBy")}</dd>
              </dl>
            </>
          }
        >
          {t.rich("denied.body", { org: orgName, needed, code, strong })}
        </StateWrap>
      );
    }
    case "pending_approval":
      return (
        <StateWrap
          testId="record-pending"
          tone="quiet"
          icon={<Lock className="size-5" />}
          title={t("pending.title")}
          actions={
            <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
              {t("denied.back")}
            </SafeLink>
          }
        >
          {t("pending.body", { request: read.accessRequestId })}
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          testId="record-error"
          tone="failed"
          icon={<CircleAlert className="size-5" />}
          title={t("error.title")}
          actions={
            <>
              <SafeLink to={retry} className={buttonPrimary}>
                {t("error.retry")}
              </SafeLink>
              <button
                type="button"
                disabled
                aria-describedby="record-error-incident"
                data-gap={RECORD_GAPS.incident}
                className={buttonSecondary}
              >
                {t("error.incident")}
              </button>
            </>
          }
          after={
            <>
              <p
                id="record-error-incident"
                data-state="not-recorded"
                className="mt-3 max-w-[52ch] text-xs text-dim"
              >
                {t("error.incidentNotRecorded")}
              </p>
              <p
                data-testid="record-error-trace"
                className="mt-4 font-mono text-[11.5px] text-dim"
              >
                {t("error.trace", { at: readAt })}
              </p>
            </>
          }
        >
          {t.rich("error.body", {
            status: String(read.status),
            code: read.code,
            mono: code,
          })}
        </StateWrap>
      );
  }
}
