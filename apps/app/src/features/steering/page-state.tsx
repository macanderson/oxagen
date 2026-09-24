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
// because the read path carries no trace id. Every state here is the shared
// StateWrap, the design's .state-wrap.
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
import { StateWrap, stateTrace } from "@/ui/state-wrap";

type Failure = Exclude<Read<unknown>, { ok: true }>;

/** The design's `.sk` shimmer (globals.css), the one every skeleton draws. */
const bar = "skeleton rounded-md";

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

/**
 * "Nothing steers this workspace yet", the All and Records shelves' empty
 * state. Its action is the screen's one gold one; the header holds none.
 */
export function SteeringEmpty({ repository }: { repository: string | null }) {
  const t = useTranslations("steering.state.empty");
  const create = useTranslations("steering.create");
  return (
    <StateWrap
      testId="steering-empty"
      tone="neutral"
      title={t("title")}
      actions={<CreateButton kind="record" label={create("record")} />}
    >
      {t.rich("body", {
        code: (chunks) => (
          <code className="font-mono text-[12px]">{chunks}</code>
        ),
        repository: repository ?? t("repository"),
      })}
    </StateWrap>
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
    <StateWrap testId={testId} tone="neutral" title={title} actions={actions}>
      {children}
    </StateWrap>
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
    <StateWrap testId={testId} tone="neutral" title={title} actions={action}>
      {children}
    </StateWrap>
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
        <StateWrap
          testId="steering-error"
          tone="failed"
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
          after={
            <p data-testid="steering-trace" className={stateTrace}>
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
        </StateWrap>
      );
    case "denied": {
      const permission = `${read.permission} on ${wsSlug}`;
      return (
        <StateWrap
          testId="steering-denied"
          tone="denied"
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
          after={
            <dl className="mx-auto mt-5 grid max-w-[420px] grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-left text-[13px]">
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
        </StateWrap>
      );
    }
    case "pending_approval":
      return (
        <StateWrap
          testId="steering-pending"
          tone="neutral"
          glyph="lock"
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </StateWrap>
      );
  }
}
