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
//
// The frame is the shared `StateWrap`. Each state replaces the page header
// too, so its title is the page's one h1.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import type { SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  kvTerm,
  kvValue,
  mono,
  panel,
  panelBody,
  panelHeader,
  statStrip,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import {
  StateWrap,
  type StateTone,
  stateCode,
  stateFacts,
  stateTrace,
} from "@/ui/state-wrap";
import { StubDialog } from "./stub-dialog";
import { CreateWorkspace } from "./workspace-actions";

type Failure = Extract<Read<unknown>, { reason: "error" }>;

/** The shared `.state-wrap`, titled with the page's h1. */
function StateBlock({
  testId,
  tone,
  title,
  children,
  actions,
  after,
}: {
  testId: string;
  tone: StateTone;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <StateWrap
      heading="h1"
      testId={testId}
      tone={tone}
      title={title}
      actions={actions}
      after={after}
    >
      {children}
    </StateWrap>
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
      <div className={statStrip}>
        {["a", "b", "c", "d"].map((tile) => (
          <div
            key={tile}
            data-skeleton="tile"
            className="skeleton h-16 rounded-[11px]"
          />
        ))}
      </div>
      <div className={panel}>
        <div className={panelHeader}>
          <div className="skeleton h-[22px] w-[180px] max-w-full rounded-[7px]" />
        </div>
        <div className={`${panelBody} flex flex-col gap-2`}>
          {[1, 2, 3, 4, 5, 6, 7].map((row) => (
            <div
              key={row}
              data-skeleton="row"
              className="skeleton h-[38px] rounded-[9px]"
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
      tone="failed"
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
        <p data-testid="organization-error-trace" className={stateTrace}>
          {line}
        </p>
      }
    >
      {t("answered")} <code className={stateCode}>{code}</code>. {t("body")}
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
  return (
    <StateBlock
      testId="organization-denied"
      tone="denied"
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
        <dl className={stateFacts}>
          <dt className={kvTerm}>{t("signedIn")}</dt>
          <dd className={kvValue} data-testid="denied-signed-in">
            {name} · <span className={mono}>{tRole(role)}</span> ·{" "}
            <span className={mono}>{org}</span>
          </dd>
          <dt className={kvTerm}>{t("neededLabel")}</dt>
          <dd className={`${kvValue} ${mono}`}>{t("needed")}</dd>
          <dt className={kvTerm}>{t("decidedBy")}</dt>
          <dd className={kvValue}>{t("decider")}</dd>
        </dl>
      }
    >
      {t("bodyBefore")} <b className="text-foreground">{orgName}</b>{" "}
      {t("bodyAfter")} <code className={stateCode}>{t("needed")}</code>.{" "}
      {t("grant")}
    </StateBlock>
  );
}
