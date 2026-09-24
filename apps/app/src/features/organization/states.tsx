// The Organization page's four not-loaded states (mockup `pOrganization`,
// pages/organization.md §States). Each replaces the page body and never the
// shell, so the sidebar, the breadcrumbs and the search stay.
//
//   loading: four tile blocks and a panel of seven rows, so nothing flashes a
//            zero and the layout does not jump when the reads land;
//   empty:   the organization has no live workspace, and Create a workspace is
//            the way in;
//   error:   the read that failed, by its status and code, with Try again and
//            Open an incident;
//   denied:  who is signed in, the permission they lack and what decided it,
//            with Request access and Back to Fleet.
//
// Open an incident (#3847) and Request access (#3820) have no capability
// behind them yet: each opens a dialog that says what it would do and that
// nothing was sent.
import { CircleAlert, LayoutPanelTop, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import type { SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StubDialog } from "./stub-dialog";
import { CreateWorkspace } from "./workspace-actions";

type Failure = Extract<Read<unknown>, { reason: "error" }>;

/** The centred state block: a glyph, a heading, a body, actions, and facts beneath. */
function StateBlock({
  testId,
  tone,
  icon,
  title,
  children,
  actions,
  after,
}: {
  testId: string;
  tone: "neutral" | "error" | "deny";
  icon: ReactNode;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  after?: ReactNode;
}) {
  const ring =
    tone === "error"
      ? "border-error/45 text-error-ink"
      : tone === "deny"
        ? "border-warning/45 text-warning"
        : "border-border text-foreground";
  return (
    <section
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      className="mx-auto flex max-w-[34rem] flex-col items-center gap-3 px-4 py-14 text-center"
    >
      <div
        className={`grid size-11 place-items-center rounded-xl border bg-card ${ring}`}
      >
        {icon}
      </div>
      <h1
        id={`${testId}-title`}
        className="text-lg font-bold tracking-[-0.01em] text-foreground"
      >
        {title}
      </h1>
      <div className="text-[13px] leading-relaxed text-muted-foreground">
        {children}
      </div>
      {actions ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      ) : null}
      {after}
    </section>
  );
}

export function OrganizationSkeleton() {
  const t = useTranslations("organization.states");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="organization-loading"
      className="flex flex-col gap-4"
    >
      <span className="sr-only">{t("loading")}</span>
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(175px,1fr))]">
        {["a", "b", "c", "d"].map((tile) => (
          <div
            key={tile}
            data-skeleton="tile"
            className="h-16 animate-pulse rounded-xl border border-border bg-card motion-reduce:animate-none"
          />
        ))}
      </div>
      <div className={panel}>
        <div className="border-b border-border px-4 py-3">
          <div className="h-3.5 w-32 animate-pulse rounded bg-hl motion-reduce:animate-none" />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          {[1, 2, 3, 4, 5, 6, 7].map((row) => (
            <div
              key={row}
              data-skeleton="row"
              className="h-9 animate-pulse rounded-md bg-hl motion-reduce:animate-none"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function OrganizationEmpty({ org }: { org: string }) {
  const t = useTranslations("organization.states.empty");
  return (
    <StateBlock
      testId="organization-empty"
      tone="neutral"
      icon={<LayoutPanelTop aria-hidden className="size-5" />}
      title={t("title")}
      actions={<CreateWorkspace org={org} primary />}
    >
      {t("body")}
    </StateBlock>
  );
}

export function OrganizationError({
  failure,
  retry,
  readAt,
}: {
  failure: Failure;
  /** Try again reloads this same tab. */
  retry: SafePath;
  /** The instant the read failed, already formatted; a render reads no clock. */
  readAt: string;
}) {
  const t = useTranslations("organization.states.error");
  const tStub = useTranslations("organization.states.stub.incident");
  const code = `${String(failure.status)} ${failure.code}`;
  const line = t("trace", {
    trace: t("traceNotRecorded"),
    region: t("traceNotRecorded"),
    at: readAt,
  });
  return (
    <StateBlock
      testId="organization-error"
      tone="error"
      icon={<CircleAlert aria-hidden className="size-5" />}
      title={t("title")}
      actions={
        <>
          <SafeLink to={retry} className={buttonPrimary}>
            {t("retry")}
          </SafeLink>
          <StubDialog
            open={tStub("open")}
            title={tStub("title")}
            body={tStub("body", { line: `${code} · ${line}` })}
            testId="organization-incident"
          />
        </>
      }
      after={
        <p
          data-testid="organization-error-trace"
          className={`${mono} text-[11px] text-dim`}
        >
          {line}
        </p>
      }
    >
      {t("answered")}{" "}
      <code className={`${mono} rounded bg-hl px-1`}>{code}</code>. {t("body")}
    </StateBlock>
  );
}

export function OrganizationDenied({
  org,
  orgName,
  name,
  role,
  fleet,
}: {
  org: string;
  orgName: string;
  /** The signed-in person's display name, or their email when they set none. */
  name: string;
  role: OrgRole;
  /** Back to Fleet: a workspace this person can open, or the app root. */
  fleet: SafePath;
}) {
  const t = useTranslations("organization.states.denied");
  const tRole = useTranslations("organization.roles");
  const tStub = useTranslations("organization.states.stub.requestAccess");
  const fact = "text-left text-[12.5px]";
  return (
    <StateBlock
      testId="organization-denied"
      tone="deny"
      icon={<Lock aria-hidden className="size-5" />}
      title={t("title")}
      actions={
        <>
          <StubDialog
            primary
            open={tStub("open")}
            title={tStub("title")}
            body={tStub("body", { org: orgName })}
            testId="organization-request-access"
          />
          <SafeLink to={fleet} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className={`${fact} text-muted-foreground`}>{t("signedIn")}</dt>
          <dd className={fact} data-testid="denied-signed-in">
            {name} · <span className={mono}>{tRole(role)}</span> ·{" "}
            <span className={mono}>{org}</span>
          </dd>
          <dt className={`${fact} text-muted-foreground`}>
            {t("neededLabel")}
          </dt>
          <dd className={`${fact} ${mono}`}>{t("needed")}</dd>
          <dt className={`${fact} text-muted-foreground`}>{t("decidedBy")}</dt>
          <dd className={fact}>{t("decider")}</dd>
        </dl>
      }
    >
      {t("bodyBefore")} <b className="text-foreground">{orgName}</b>{" "}
      {t("bodyAfter")}{" "}
      <code className={`${mono} rounded bg-hl px-1`}>{t("needed")}</code>.{" "}
      {t("grant")}
    </StateBlock>
  );
}
