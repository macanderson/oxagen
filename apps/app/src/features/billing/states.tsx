// The Billing page's not-loaded states (pages/billing.md, States). Each
// replaces the page body, header included, and never the shell: the sidebar,
// the breadcrumbs and the search stay, so a reader keeps their bearings. The
// shape is the mockup's `.state-wrap`: a glyph, a heading, one paragraph, the
// actions, and on the error and denied states a line of what was recorded.
//
//   - loading: four tile blocks and a panel of seven rows; no figure, no zero.
//   - empty: nothing billable yet, with Back to Fleet.
//   - error: the code the read path answered, Try again (this same page) and
//     Open an incident, then the trace line. The read path carries no trace id
//     and no region, so the line says so and prints the instant of the read.
//   - denied: the permission the read needed, Request access and Back to
//     Fleet, then who is signed in (name and role), what was needed, and what
//     decided it. A refusal carries no policy version yet (#3846), so the
//     Decided by line says the version is not recorded.
//   - pending: an access request the kernel parked for approval.
import { CircleAlert, Lock, PanelsTopLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { OrgRole } from "@/data/contracts/common";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
  statStrip,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { OpenIncident, RequestAccess } from "./state-dialogs";

const codeChip = `${mono} rounded bg-muted px-1`;

const bar = "animate-pulse rounded bg-muted motion-reduce:animate-none";

export function BillingSkeleton() {
  const t = useTranslations("billing.state");
  return (
    <div
      aria-busy="true"
      aria-label={t("loading")}
      role="status"
      data-state="loading"
      className="flex flex-col gap-4"
    >
      <div className={statStrip}>
        {[0, 1, 2, 3].map((tile) => (
          <span key={tile} className={`${bar} h-16 rounded-xl`} />
        ))}
      </div>
      <div className={`${panel} flex flex-col`}>
        <div className="border-b border-border px-4 py-3">
          <span className={`${bar} block h-4 w-44`} />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <span key={row} className={`${bar} block h-7 w-full`} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StateWrap({
  state,
  icon,
  tone,
  title,
  body,
  actions,
  after,
}: {
  state: string;
  icon: ReactNode;
  tone: "neutral" | "error" | "denied";
  title: string;
  body: ReactNode;
  actions?: ReactNode;
  after?: ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-error/40 text-error-ink"
      : tone === "denied"
        ? "border-warning/40 text-warning"
        : "border-border text-muted-foreground";
  return (
    <section
      aria-labelledby={`billing-${state}-title`}
      data-state={state}
      className="mx-auto flex max-w-[460px] flex-col items-center gap-3 px-4 py-16 text-center"
    >
      <div
        aria-hidden="true"
        className={`grid size-11 place-items-center rounded-lg border ${toneClass}`}
      >
        {icon}
      </div>
      <h2
        id={`billing-${state}-title`}
        className="text-lg font-semibold text-foreground"
      >
        {title}
      </h2>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {body}
      </p>
      {actions ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      ) : null}
      {after}
    </section>
  );
}

export function BillingEmpty() {
  const t = useTranslations("billing.state.empty");
  return (
    <StateWrap
      state="empty"
      tone="neutral"
      icon={<PanelsTopLeft className="size-5" />}
      title={t("title")}
      body={t("body")}
      actions={
        <SafeLink
          to={routes.root()}
          data-touch-target=""
          className={buttonSecondary}
        >
          {t("back")}
        </SafeLink>
      }
    />
  );
}

export function BillingError({
  code,
  status,
  at,
  retry,
}: {
  code: string;
  status: number;
  /** The instant the read failed, as the caller formatted it. */
  at: string;
  /** Where Try again points: this same page. */
  retry: SafePath;
}) {
  const t = useTranslations("billing.state.error");
  return (
    <StateWrap
      state="error"
      tone="error"
      icon={<CircleAlert className="size-5" />}
      title={t("title")}
      body={t.rich("body", {
        status: String(status),
        errorCode: code,
        code: (chunks) => <code className={codeChip}>{chunks}</code>,
      })}
      actions={
        <>
          <SafeLink to={retry} data-touch-target="" className={buttonPrimary}>
            {t("retry")}
          </SafeLink>
          <OpenIncident code={`${String(status)} ${code}`} at={at} />
        </>
      }
      after={
        <p className={`${mono} mt-3 text-[11.5px] text-dim`}>
          {t("trace", { at })}
        </p>
      }
    />
  );
}

export function BillingDenied({
  org,
  permission,
  name,
  role,
}: {
  /** The organization's display name. */
  org: string;
  /** The permission the read was refused on. */
  permission: string;
  /** The signed-in person's name; null when the session carries none. */
  name: string | null;
  /** The signed-in person's role on the organization. */
  role: OrgRole;
}) {
  const t = useTranslations("billing.state.denied");
  const roles = useTranslations("billing.roles");
  const term = "text-muted-foreground";
  return (
    <StateWrap
      state="denied"
      tone="denied"
      icon={<Lock className="size-5" />}
      title={t("title")}
      body={t.rich("body", {
        org,
        permission,
        b: (chunks) => <b className="text-foreground">{chunks}</b>,
        code: (chunks) => <code className={codeChip}>{chunks}</code>,
      })}
      actions={
        <>
          <RequestAccess permission={permission} />
          <SafeLink
            to={routes.root()}
            data-touch-target=""
            className={buttonSecondary}
          >
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <dl className="mt-4 grid w-full max-w-[420px] grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-left text-[12.5px]">
          <dt className={term}>{t("signedIn")}</dt>
          <dd data-fact="signed-in" className={mono}>
            {name === null
              ? roles(role)
              : t("signedInValue", { name, role: roles(role) })}
          </dd>
          <dt className={term}>{t("needed")}</dt>
          <dd data-fact="needed">
            {t.rich("neededValue", {
              permission,
              code: (chunks) => <span className={mono}>{chunks}</span>,
            })}
          </dd>
          <dt className={term}>{t("decidedBy")}</dt>
          <dd data-fact="decided-by">
            {t.rich("decidedByValue", {
              policy: (chunks) => (
                <span data-recorded="false" className="text-muted-foreground">
                  {chunks}
                </span>
              ),
            })}
          </dd>
        </dl>
      }
    />
  );
}

export function BillingPending({ request }: { request: string }) {
  const t = useTranslations("billing.state.pending");
  return (
    <StateWrap
      state="pending"
      tone="neutral"
      icon={<Lock className="size-5" />}
      title={t("title")}
      body={t("body", { request })}
    />
  );
}
