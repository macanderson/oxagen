"use client";
// The not-loaded states of the Repositories page (mockups/pages/
// repositories.md, "States"; mockup `skeleton`, `emptyState`, `errorState`,
// `deniedState`). Each replaces the page body, header and tabs included, and
// never the shell.
//
// *Request access* and *Open an incident* are drawn, disabled, with the line
// that says what they would do: no contract lets a person ask for a role
// (#3820) or open an incident from a page (#3847).
import { CircleAlert, Lock, PanelTop } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PAGE_FAILURES } from "@/data/read";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
  panelBody,
  panelHeader,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import type { RepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";

const inline = (chunks: ReactNode) => (
  <code className="rounded bg-hl px-1 font-mono text-[0.92em] text-foreground">
    {chunks}
  </code>
);
const strong = (chunks: ReactNode) => (
  <b className="font-semibold text-foreground">{chunks}</b>
);

function StateWrap({
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

const bar = "animate-pulse rounded-md bg-hl motion-reduce:animate-none";

/** The skeleton (mockup `skeleton()`): four tiles and a panel of rows, textless. */
export function LoadingBody() {
  const t = useTranslations("repositories.page");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      data-testid="repositories-loading"
      className="flex flex-col gap-4"
    >
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(175px,1fr))]">
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className={`${bar} h-16 rounded-xl`} />
        ))}
      </div>
      <div className={panel}>
        <div className={panelHeader}>
          <div className={`${bar} h-4 w-44`} />
        </div>
        <div className={`${panelBody} flex flex-col gap-2`}>
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <div key={row} className={`${bar} h-9`} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The error state. The page's own failure carries its status; any other code is printed as recorded. */
export function ErrorBody({
  failure,
  readAt,
  onRetry,
}: {
  failure: RepositoriesFailure;
  /** When the read failed, formatted. */
  readAt: string;
  onRetry: () => void;
}) {
  const t = useTranslations("repositories.page.error");
  const known = PAGE_FAILURES.repositories.error;
  const code = "code" in failure ? failure.code : failure.reason;
  const answer =
    code === known.code ? `${String(known.status)} ${code}` : code;
  return (
    <StateWrap
      testId="repositories-error"
      tone="failed"
      icon={<CircleAlert className="size-5" />}
      title={t("title")}
      actions={
        <>
          <button
            type="button"
            data-testid="repositories-retry"
            onClick={onRetry}
            className={buttonPrimary}
          >
            {t("retry")}
          </button>
          <button
            type="button"
            disabled
            aria-describedby="repositories-error-incident"
            data-gap={REPOSITORY_GAPS.incident}
            className={buttonSecondary}
          >
            {t("incident")}
          </button>
        </>
      }
      after={
        <>
          <p
            id="repositories-error-incident"
            data-state="not-recorded"
            className="mt-3 max-w-[52ch] text-xs text-dim"
          >
            {t("incidentNotRecorded")}
          </p>
          <p
            data-testid="repositories-error-trace"
            className="mt-4 font-mono text-[11.5px] text-dim"
          >
            {t("trace", { at: readAt })}
          </p>
        </>
      }
    >
      {t.rich("body", { answer, code: inline })}
    </StateWrap>
  );
}

export function DeniedBody({
  org,
  orgName,
  ws,
  failure,
  viewer,
}: {
  org: string;
  orgName: string;
  ws: string;
  failure: RepositoriesFailure;
  viewer: { name: string; role: string };
}) {
  const t = useTranslations("repositories.page.denied");
  const permission =
    "code" in failure && failure.code.includes(".")
      ? failure.code
      : PAGE_FAILURES.repositories.permission;
  const needed = t("needed", { permission, ws });
  return (
    <StateWrap
      testId="repositories-denied"
      tone="denied"
      icon={<Lock className="size-5" />}
      title={t("title")}
      actions={
        <>
          <button
            type="button"
            disabled
            aria-describedby="repositories-denied-request"
            data-gap={REPOSITORY_GAPS.requestAccess}
            className={buttonPrimary}
          >
            {t("request")}
          </button>
          <SafeLink
            to={routes.fleet(org, ws)}
            data-testid="repositories-back-to-fleet"
            className={buttonSecondary}
          >
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <>
          <p
            id="repositories-denied-request"
            data-state="not-recorded"
            className="mt-3 max-w-[52ch] text-xs text-dim"
          >
            {t("requestNotRecorded", { needed })}
          </p>
          <dl className="mt-5 grid max-w-[420px] grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-left text-[13px] [&>dd]:text-foreground [&>dt]:text-muted-foreground">
            <dt>{t("signedInTerm")}</dt>
            <dd data-testid="repositories-denied-roles">
              {t.rich("signedIn", {
                name: viewer.name,
                role: viewer.role,
                code: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </dd>
            <dt>{t("neededTerm")}</dt>
            <dd className={mono}>{needed}</dd>
            <dt>{t("decidedByTerm")}</dt>
            <dd>{t("decidedBy")}</dd>
          </dl>
        </>
      }
    >
      {t.rich("body", { org: orgName, needed, code: inline, strong })}
    </StateWrap>
  );
}

/** A workspace that binds nothing yet: the one gold action opens the init wizard. */
export function EmptyBody({ onAddOxagen }: { onAddOxagen: () => void }) {
  const t = useTranslations("repositories.page");
  return (
    <StateWrap
      testId="repositories-empty"
      tone="quiet"
      icon={<PanelTop className="size-5" />}
      title={t("empty.title")}
      actions={
        <button
          type="button"
          data-testid="repositories-empty-add"
          aria-haspopup="dialog"
          onClick={onAddOxagen}
          className={buttonPrimary}
        >
          {t("addOxagen")}
        </button>
      }
    >
      {t("empty.body")}
    </StateWrap>
  );
}
