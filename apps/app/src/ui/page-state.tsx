// The states a page shows when it has nothing to draw: an error, an access
// denial, an access request still waiting, an empty list, and an address that
// matches no page. Every page and every route boundary draws them from here,
// so they look and read the same everywhere.
//
// The shape is the design's `.state-wrap`: a glyph tile, a heading, one
// paragraph, the actions, and an optional line or list beneath, centred with
// no panel around them. The copy is the design's, with two lines changed to
// what the record holds (#3841). A failed read carries no region, so the trace
// line says so and prints the trace id only when there is one. A refusal
// carries only the permission it needed, so "Decided by" says the policy was
// not recorded.
//
// No directive: a server page renders these directly, and an error boundary
// (a client component) renders them with its own retry.
import { CircleAlert, FileQuestionMark, Lock, PanelTop } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { OpenIncident, RequestAccess, TryAgain } from "@/ui/page-state-actions";

const TONE = {
  neutral: "text-muted-foreground",
  failed: "text-error-ink border-error/40",
  denied: "text-warning border-warning/40",
} as const;

type StateTone = keyof typeof TONE;

const codeTag = (chunks: ReactNode) => (
  <code className={`${mono} rounded bg-muted px-1`}>{chunks}</code>
);

/**
 * The frame every state shares. `children` is the one paragraph under the
 * heading. A state that replaces the whole page, as an error boundary or a
 * not-found page does, passes `heading="h1"` so the page keeps one h1.
 */
export function StateWrap({
  testId,
  tone,
  icon,
  title,
  children,
  actions,
  after,
  heading = "h2",
  state,
  alert = false,
}: {
  testId: string;
  tone: StateTone;
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  after?: ReactNode;
  heading?: "h1" | "h2";
  /** Written to `data-state`, for a page whose tests and styles key on it. */
  state?: string;
  /** Announce the state when it appears, as a failed read should be. */
  alert?: boolean;
}) {
  const Heading = heading;
  return (
    <section
      data-testid={testId}
      data-state={state}
      role={alert ? "alert" : undefined}
      aria-labelledby={`${testId}-title`}
      className="grid place-items-center px-5 py-[60px] text-center"
    >
      <div
        aria-hidden="true"
        className={`mb-3.5 grid size-11 place-items-center rounded-xl border border-border bg-card ${TONE[tone]}`}
      >
        {icon}
      </div>
      <Heading id={`${testId}-title`} className="mb-[7px] text-lg font-semibold">
        {title}
      </Heading>
      {children === undefined ? null : (
        <p className="mx-auto mb-4 max-w-[52ch] text-[13px] text-muted-foreground">
          {children}
        </p>
      )}
      {actions === undefined ? null : (
        <div className="flex flex-wrap justify-center gap-[9px]">{actions}</div>
      )}
      {after}
    </section>
  );
}

/** The design's denied-state list: who is signed in, what was needed, who decided. */
export function StateFacts({
  rows,
  testId,
}: {
  rows: readonly { term: string; value: ReactNode; testId?: string }[];
  testId?: string;
}) {
  return (
    <dl
      data-testid={testId}
      className="mt-5 grid max-w-[420px] grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-[7px] text-left text-[12.5px]"
    >
      {rows.map((row) => (
        <div key={row.term} data-testid={row.testId} className="contents">
          <dt className="text-dim">{row.term}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The mono line under an error: the trace id, or that none was recorded. */
export function TraceLine({
  text,
  recorded,
  testId,
}: {
  text: ReactNode;
  recorded: boolean;
  testId?: string;
}) {
  return (
    <p data-testid={testId} className={`${mono} mt-4 text-[11.5px] text-dim`}>
      <span data-recorded={String(recorded)}>{text}</span>
    </p>
  );
}

export function ErrorState({
  what,
  code,
  onRetry,
  trace,
  testId = "page-error",
  heading,
}: {
  /** The page or section that failed, as its heading names it. */
  what: string;
  /** The answer the read path gave, as `503 run_index_unavailable`. */
  code: string;
  /** An error boundary's retry. Left out, Try again refreshes the route. */
  onRetry?: () => void;
  /** The trace id, when the failure carried one (an error digest). */
  trace?: string;
  testId?: string;
  heading?: "h1" | "h2";
}) {
  const t = useTranslations("ui.pageState.error");
  return (
    <StateWrap
      testId={testId}
      tone="failed"
      icon={<CircleAlert className="size-5" />}
      title={t("title", { what })}
      heading={heading}
      alert
      actions={
        <>
          <TryAgain onRetry={onRetry} />
          <OpenIncident code={code} />
        </>
      }
      after={
        <TraceLine
          testId={`${testId}-trace`}
          recorded={trace !== undefined}
          text={
            trace === undefined ? t("traceUnrecorded") : t("trace", { trace })
          }
        />
      }
    >
      {t.rich("body", { code, c: codeTag })}
    </StateWrap>
  );
}

export function DeniedState({
  what,
  need,
  org,
  orgName = org,
  signedInAs,
  role,
  back = routes.root(),
  testId = "page-denied",
}: {
  /** What the reader cannot see, as the heading names it: "this workspace". */
  what: string;
  /** The permission the read needed, as the design prints it. */
  need: string;
  /** The organization slug, for the link to the people who can grant it. */
  org: string;
  /** The organization's display name. Defaults to the slug. */
  orgName?: string;
  /** The signed-in person's name, or their email when they set no name. */
  signedInAs: string;
  /** Their role, as `workspace.viewer`. */
  role: string;
  /** Where Back to Fleet goes. Defaults to `/`, which opens the first workspace. */
  back?: SafePath;
  testId?: string;
}) {
  const t = useTranslations("ui.pageState.denied");
  return (
    <StateWrap
      testId={testId}
      tone="denied"
      icon={<Lock className="size-5" />}
      title={t("title", { what })}
      actions={
        <>
          <RequestAccess org={org} need={need} />
          <SafeLink to={back} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <StateFacts
          rows={[
            {
              term: t("signedIn"),
              value: t.rich("signedInValue", {
                name: signedInAs,
                role,
                c: (chunks) => <span className={mono}>{chunks}</span>,
              }),
            },
            {
              term: t("needed"),
              value: <span className={mono}>{need}</span>,
            },
            { term: t("decidedBy"), value: t("decidedByValue") },
          ]}
        />
      }
    >
      {t.rich("body", {
        org: orgName,
        need,
        b: (chunks) => <b className="text-foreground">{chunks}</b>,
        c: codeTag,
      })}
    </StateWrap>
  );
}

export function PendingState({
  what,
  request,
  testId = "page-pending",
}: {
  what: string;
  /** The access request's id. */
  request: string;
  testId?: string;
}) {
  const t = useTranslations("ui.pageState.pending");
  return (
    <StateWrap
      testId={testId}
      tone="neutral"
      icon={<Lock className="size-5" />}
      title={t("title")}
    >
      {t("body", { what, request })}
    </StateWrap>
  );
}

export function EmptyState({
  title,
  body,
  actions,
  icon = <PanelTop className="size-5" />,
  testId = "page-empty",
}: {
  title: string;
  body: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <StateWrap
      testId={testId}
      tone="neutral"
      icon={icon}
      title={title}
      actions={actions}
    >
      {body}
    </StateWrap>
  );
}

type NotFoundScope =
  | { scope: "app" }
  | { scope: "organization"; org: string }
  | { scope: "workspace"; org: string; ws: string };

/**
 * An address that matches no page. It replaces the page, so its heading is
 * the page's h1, and its one action leads back to the nearest page that does
 * exist.
 */
export function NotFoundState(props: NotFoundScope) {
  const t = useTranslations("notFound");
  let body: string;
  let back: SafePath;
  let label: string;
  switch (props.scope) {
    case "app":
      body = t("body");
      back = routes.root();
      label = t("home");
      break;
    case "organization":
      body = t("organization");
      back = routes.people(props.org);
      label = t("organizationHome");
      break;
    case "workspace":
      body = t("workspace");
      back = routes.fleet(props.org, props.ws);
      label = t("fleet");
      break;
  }
  return (
    <StateWrap
      testId="page-not-found"
      tone="neutral"
      icon={<FileQuestionMark className="size-5" />}
      title={t("title")}
      heading="h1"
      actions={
        <SafeLink to={back} className={buttonSecondary}>
          {label}
        </SafeLink>
      }
    >
      {body}
    </StateWrap>
  );
}
