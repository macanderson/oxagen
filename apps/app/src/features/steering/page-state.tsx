// The Steering page's not-loaded states and its empty state (roadmap
// pages/steering.md, States). Loading, error and access denied replace the
// page body, the hub header included, and never the shell. The empty state
// keeps the header, the governance chip and the five tabs, and its reason
// names what is missing on the shelf or tab in view.
//
// Two controls the design draws have no backing: no contract files an
// incident and none records an access request. Each is a stub that says what
// Oxagen would do and what to do instead (./stub-action.tsx). The design's
// trace line prints the status, the code and the instant the read failed,
// because the read path carries no trace id.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  panel,
  panelBody,
  panelHeader,
  statStrip,
  statTile,
} from "@/ui/control-styles";
import { CreateButton } from "@/ui/create-button";
import { STEERING_GAPS } from "./gaps";
import { SafeLink } from "@/ui/navigation";
import { StubAction } from "./stub-action";

type Failure = Exclude<Read<unknown>, { ok: true }>;

const bar = "animate-pulse rounded bg-muted motion-reduce:animate-none";

/** Four tile blocks and a panel of seven rows (`skeleton()`). */
export function SteeringLoading() {
  const t = useTranslations("steering.state");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      data-testid="steering-loading"
      className="flex flex-col gap-4"
    >
      <div className={statStrip}>
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className={`${statTile} h-[88px]`}>
            <div className={`${bar} h-3 w-20`} />
            <div className={`${bar} mt-3 h-6 w-14`} />
          </div>
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

/** The `.state-wrap` frame every state here draws: a glyph, a heading, a body and actions. */
function StateFrame({
  testId,
  tone,
  icon,
  title,
  children,
  actions,
  footer,
}: {
  testId: string;
  tone: "neutral" | "failed" | "denied";
  icon: ReactNode;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  const ring =
    tone === "failed"
      ? "border-error/40 text-error-ink"
      : tone === "denied"
        ? "border-warning/40 text-warning"
        : "border-border text-muted-foreground";
  return (
    <section
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
      <div className="mx-auto mb-4 max-w-[52ch] text-[13px] text-muted-foreground">
        {children}
      </div>
      {actions ? (
        <div className="flex max-w-[52ch] flex-wrap justify-center gap-[9px]">
          {actions}
        </div>
      ) : null}
      {footer}
    </section>
  );
}

const glyph = "size-5";

function TableGlyph() {
  return (
    <svg
      className={glyph}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}

function AlertGlyph() {
  return (
    <svg
      className={glyph}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M12 8v5M12 17h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg
      className={glyph}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * "Nothing steers this workspace yet", the All and Records shelves' empty
 * state. Its action is the screen's one gold one; the header holds none.
 */
export function SteeringEmpty({ repository }: { repository: string | null }) {
  const t = useTranslations("steering.state.empty");
  const create = useTranslations("steering.create");
  return (
    <StateFrame
      testId="steering-empty"
      tone="neutral"
      icon={<TableGlyph />}
      title={t("title")}
      actions={<CreateButton kind="record" label={create("record")} />}
    >
      {t.rich("body", {
        code: (chunks) => (
          <code className="font-mono text-[12px]">{chunks}</code>
        ),
        repository: repository ?? t("repository"),
      })}
    </StateFrame>
  );
}

/**
 * A Library shelf's own empty state (the Memory shelf's "Nothing has been
 * recalled yet"): the same frame, the shelf's words, and its action where it
 * has one. The header holds no gold while it shows.
 */
export function ShelfEmpty({
  testId,
  title,
  children,
  actions,
}: {
  testId: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <StateFrame
      testId={testId}
      tone="neutral"
      icon={<TableGlyph />}
      title={title}
      actions={actions}
    >
      {children}
    </StateFrame>
  );
}

/**
 * A tab's own empty state (Assignments, Proposals, the Compiler): the same
 * frame, with the copy and the one action its spec names. Whether that action
 * is gold is the caller's; the header gives up its gold on every empty state.
 */
export function TabEmpty({
  testId,
  title,
  action,
  children,
}: {
  testId: string;
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <StateFrame
      testId={testId}
      tone="neutral"
      icon={<TableGlyph />}
      title={title}
      actions={action}
    >
      {children}
    </StateFrame>
  );
}

export function SteeringFailure({
  read,
  org,
  ws,
  orgName,
  wsSlug,
  wsRole,
  viewer,
  retry,
  readAt,
}: {
  read: Failure;
  org: string;
  ws: string;
  orgName: string;
  wsSlug: string;
  /** The signed-in person's workspace role, lowercased as the viewer carries it. */
  wsRole: string;
  /** The signed-in person's name, or their email where no name is set; null when the session gave neither. */
  viewer: string | null;
  /** Where Try again points: the view that failed. */
  retry: SafePath;
  /** The instant the read was attempted, formatted by the caller. */
  readAt: string;
}) {
  const t = useTranslations("steering.state");
  switch (read.reason) {
    case "error":
      return (
        <StateFrame
          testId="steering-error"
          tone="failed"
          icon={<AlertGlyph />}
          title={t("error.title")}
          actions={
            <>
              <SafeLink to={retry} className={buttonPrimary}>
                {t("error.retry")}
              </SafeLink>
              <StubAction
                testId="steering-incident"
                label={t("error.incident")}
                note={t("error.incidentNote")}
                className={buttonSecondary}
              />
            </>
          }
          footer={
            <p
              data-testid="steering-trace"
              className="mt-4 font-mono text-[11.5px] text-dim"
            >
              {t("error.trace", {
                status: String(read.status),
                code: read.code,
                at: readAt,
              })}
            </p>
          }
        >
          {t.rich("error.answered", {
            answer: `${String(read.status)} ${read.code}`,
            code: (chunks) => (
              <code className="font-mono text-[12px]">{chunks}</code>
            ),
          })}{" "}
          {t("error.body")}
        </StateFrame>
      );
    case "denied": {
      const permission = `${read.permission} on ${wsSlug}`;
      return (
        <StateFrame
          testId="steering-denied"
          tone="denied"
          icon={<LockGlyph />}
          title={t("denied.title")}
          actions={
            <>
              <StubAction
                testId="steering-request-access"
                label={t("denied.request")}
                note={t("denied.requestNote", { permission })}
                className={buttonPrimary}
              />
              <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
                {t("denied.back")}
              </SafeLink>
            </>
          }
          footer={
            <dl className="mt-5 grid max-w-[420px] grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-left text-[13px]">
              <dt className="text-muted-foreground">{t("denied.signedIn")}</dt>
              {/* The design sets the person's name in the sans face and the role and workspace, which are identifiers, in mono. */}
              <dd data-testid="steering-signed-in">
                {viewer === null ? (
                  <span className="font-mono text-[12px]">
                    {t("denied.signedInValue", {
                      role: wsRole,
                      workspace: wsSlug,
                    })}
                  </span>
                ) : (
                  t.rich("denied.signedInNamed", {
                    name: viewer,
                    role: wsRole,
                    workspace: wsSlug,
                    person: (chunks) => (
                      <span className="font-sans" data-signed-in="name">
                        {chunks}
                      </span>
                    ),
                    mono: (chunks) => (
                      <span
                        className="font-mono text-[12px]"
                        data-signed-in="role"
                      >
                        {chunks}
                      </span>
                    ),
                  })
                )}
              </dd>
              <dt className="text-muted-foreground">{t("denied.needed")}</dt>
              <dd className="font-mono text-[12px]">
                {t("denied.neededValue", {
                  permission: read.permission,
                  workspace: wsSlug,
                })}
              </dd>
              <dt className="text-muted-foreground">{t("denied.decidedBy")}</dt>
              <dd data-testid="steering-decided-by">
                {t("denied.decidedByValue", {
                  issue: String(STEERING_GAPS.denial),
                })}
              </dd>
            </dl>
          }
        >
          {t.rich("denied.body", {
            org: orgName,
            permission,
            b: (chunks) => <b className="text-foreground">{chunks}</b>,
            code: (chunks) => (
              <code className="font-mono text-[12px]">{chunks}</code>
            ),
          })}
        </StateFrame>
      );
    }
    case "pending_approval":
      return (
        <StateFrame
          testId="steering-pending"
          tone="neutral"
          icon={<LockGlyph />}
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </StateFrame>
      );
  }
}
