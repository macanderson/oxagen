// The Spend page's not-loaded states (#2962; spec "States"): loading, empty,
// error, access denied, and an access request still waiting. Each replaces
// the page body, the header included, as the design draws it, and never the
// shell: the sidebar, the breadcrumbs and the search stay. The page keeps its
// one h1 for assistive technology. Request access and Open an incident have no
// contract yet, so each opens a dialog that says what it would do and that
// nothing was sent (#3846, #3847); the trace id, the region and the deciding
// policy are not on a failed read yet (#3841), and the lines say so. Each
// state is the shared `StateWrap`, the design's `.state-wrap`, with no panel
// around it (#4048).
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  kvTerm,
  kvValue,
  mono,
  panel,
  statStrip,
  statTile,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateCode, stateFacts, stateTrace } from "@/ui/state-wrap";
import { GAP_ISSUE } from "./not-backed";
import { StubDialog } from "./stub-dialog";

type Failed = Extract<Read<never>, { ok: false }>;

/** The page's h1, kept for assistive technology while a state replaces the header. */
function HiddenTitle() {
  const t = useTranslations("pages");
  return <h1 className="sr-only">{t("spend")}</h1>;
}

const TILES = [0, 1, 2, 3];
const ROWS = [0, 1, 2, 3, 4, 5, 6];
/** The design's `.sk` shimmer (globals.css) at its 6px corners, the one every skeleton draws. */
const bone = "skeleton rounded-md";

/**
 * The route's loading state: four tile blocks and a panel of seven rows, the
 * shape of what is coming. The frame keeps the page's container classes but is
 * a busy region, not a `main`: React holds the resolved page hidden beside this
 * fallback, and only the page may own the landmark. A second `main`, with or
 * without an `id`, gives the document two main landmarks during the swap
 * (#4053, arch/loading-landmarks.test.ts).
 */
export function SpendLoading() {
  const t = useTranslations("spend.states");
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <div
        role="status"
        aria-busy="true"
        data-testid="spend-loading"
        className="flex flex-col gap-3.5"
      >
        <HiddenTitle />
        <span className="sr-only">{t("loading")}</span>
        <div className={statStrip}>
          {TILES.map((tile) => (
            <span key={tile} aria-hidden="true" className={statTile}>
              <span className={`mb-2 block h-2.5 w-20 ${bone}`} />
              <span className={`block h-6 w-16 ${bone}`} />
              <span className={`mt-2 block h-2.5 w-28 ${bone}`} />
            </span>
          ))}
        </div>
        <div className={`${panel} flex flex-col gap-3 p-4`}>
          <span aria-hidden="true" className={`h-4 w-40 ${bone}`} />
          {ROWS.map((row) => (
            <span key={row} aria-hidden="true" className={`h-8 ${bone}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SpendEmpty({ ctx }: { ctx: WsCtx }) {
  const t = useTranslations("spend.states.empty");
  return (
    <div data-state="empty">
      <HiddenTitle />
      <StateWrap
        tone="neutral"
        testId="spend-empty"
        title={t("title")}
        actions={
          <SafeLink
            to={routes.fleet(ctx.orgSlug, ctx.wsSlug)}
            className={buttonSecondary}
          >
            {t("back")}
          </SafeLink>
        }
      >
        {t("body")}
      </StateWrap>
    </div>
  );
}

export function SpendReadFailure({
  read,
  ctx,
  retry,
  readAt,
  inline = false,
}: {
  read: Failed;
  ctx: WsCtx;
  /**
   * A tab's own read failed under a page that did load: the state replaces the
   * tab body only, and the header's h1 stays the page's one.
   */
  inline?: boolean;
  /** Where Try again points: this same view. */
  retry: SafePath;
  /** The instant the read failed, ISO 8601, taken by the caller. */
  readAt: string;
}) {
  const t = useTranslations("spend.states");
  const heading = inline ? null : <HiddenTitle />;
  switch (read.reason) {
    case "denied": {
      const needed = t("denied.needed", {
        permission: read.permission,
        workspace: ctx.wsSlug,
      });
      return (
        <div data-state="denied">
          {heading}
          <StateWrap
            tone="denied"
            testId="spend-denied"
            title={t("denied.title")}
            actions={
              <>
                <StubDialog
                  primary
                  label={t("denied.request")}
                  title={t("denied.requestTitle")}
                  body={t("denied.requestBody", { needed })}
                  issue={GAP_ISSUE.access}
                  testId="spend-request-access"
                />
                <SafeLink
                  to={routes.fleet(ctx.orgSlug, ctx.wsSlug)}
                  className={buttonSecondary}
                >
                  {t("denied.back")}
                </SafeLink>
              </>
            }
            after={
              <dl className={stateFacts}>
                <dt className={kvTerm}>{t("denied.signedInAs")}</dt>
                <dd className={`${kvValue} ${mono}`}>
                  {t("denied.roles", {
                    orgRole: ctx.orgRole,
                    wsRole: ctx.wsRole,
                    workspace: ctx.wsSlug,
                  })}
                </dd>
                <dt className={kvTerm}>{t("denied.neededLabel")}</dt>
                <dd className={`${kvValue} ${mono}`}>{needed}</dd>
                <dt className={kvTerm}>{t("denied.decidedByLabel")}</dt>
                <dd data-issue={GAP_ISSUE.trace} className={kvValue}>
                  {t("denied.decidedBy")}
                </dd>
              </dl>
            }
          >
            {t("denied.body", { organization: ctx.orgName })}{" "}
            <code className={stateCode}>{needed}</code>
            {t("denied.bodyEnd")}
          </StateWrap>
        </div>
      );
    }
    case "pending_approval":
      return (
        <div data-state="pending_approval">
          {heading}
          <StateWrap
            tone="neutral"
            glyph="lock"
            testId="spend-pending"
            title={t("pending.title")}
          >
            <span className={mono}>
              {t("pending.body", { request: read.accessRequestId })}
            </span>
          </StateWrap>
        </div>
      );
    case "error": {
      const code = `${String(read.status)} ${read.code}`;
      return (
        <div data-state="error">
          {heading}
          <StateWrap
            tone="failed"
            testId="spend-error"
            title={t("error.title")}
            actions={
              <>
                <SafeLink to={retry} className={buttonPrimary}>
                  {t("error.retry")}
                </SafeLink>
                <StubDialog
                  label={t("error.incident")}
                  title={t("error.incidentTitle")}
                  body={t("error.incidentBody", { code })}
                  issue={GAP_ISSUE.incident}
                  testId="spend-incident"
                />
              </>
            }
            after={
              <p data-issue={GAP_ISSUE.trace} className={stateTrace}>
                {t("error.trace", { at: readAt })}
              </p>
            }
          >
            {t("error.bodyStart")} <code className={stateCode}>{code}</code>
            {t("error.bodyEnd")}
          </StateWrap>
        </div>
      );
    }
  }
}

/**
 * A section's own read that did not answer, inside a tab that did: a compact
 * panel naming the refusal, the waiting request or the error code. It never
 * replaces the page, since the sections beside it still answered.
 */
export function SpendSectionFailure({ read }: { read: Failed }) {
  const t = useTranslations("spend.states");
  return (
    <section
      data-state={read.reason}
      className={`${panel} flex flex-col gap-2 p-5`}
    >
      <h2 className="text-base font-semibold">
        {read.reason === "denied"
          ? t("denied.title")
          : read.reason === "pending_approval"
            ? t("pending.title")
            : t("error.title")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {read.reason === "denied" ? (
          t("section.denied", { permission: read.permission })
        ) : read.reason === "pending_approval" ? (
          <span className={mono}>
            {t("pending.body", { request: read.accessRequestId })}
          </span>
        ) : (
          t("section.error", { code: read.code, status: String(read.status) })
        )}
      </p>
    </section>
  );
}
