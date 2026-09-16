// The onboarding gate on Fleet (#2967, ADR-065 decision 1): the rail while the
// gate is open, the provisional-workspace banner while no main repository is
// bound, and the first-run banner once the first frame opened the gate.
//
// An organization that predates the gate has no row: it reads as `unlocked`
// with no provisional window, so nothing is drawn. A read that failed draws
// nothing either — the gate is a banner over Fleet, and Fleet's own sections
// report their own failures (§3.6).
import "server-only";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { OnboardingGate as Gate } from "@/data/contracts/onboarding";
import type { DataSource } from "@/data/ports";
import type { OrgCtx, WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { Rail, type RailStep } from "./rail";
import { gateRail, type GateStep } from "./steps";

function Banner({
  testId,
  badge,
  title,
  children,
  action,
}: {
  testId: string;
  badge: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className={`${panel} flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:gap-4`}
    >
      <span className="inline-flex flex-none items-center rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        {badge}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="max-w-prose text-sm text-muted-foreground">
          {children}
        </div>
      </div>
      {action === undefined ? null : (
        <div className="flex flex-none items-center">{action}</div>
      )}
    </section>
  );
}

function GateRail({
  step,
  org,
  ws,
}: {
  step: Gate["step"];
  org: string;
  ws: string;
}) {
  const t = useTranslations("onboarding.gate");
  const steps: RailStep[] = gateRail(step, { org, ws }).map((item) => ({
    key: item.step,
    label: t(`steps.${item.step satisfies GateStep}`),
    sub: t(`subs.${item.step satisfies GateStep}`),
    state: item.state,
    stateLabel: t(`state.${item.state}`),
    to: item.to,
  }));
  return (
    <section
      data-testid="onboarding-rail"
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("lead")}
        </p>
      </div>
      <Rail label={t("railLabel")} steps={steps} />
    </section>
  );
}

function Provisional({
  provisional,
  workspace,
  org,
  ws,
}: {
  provisional: NonNullable<Gate["provisional"]>;
  workspace: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("onboarding.gate.provisional");
  const format = useFormatter();
  const repository = provisional.detectedRepository;
  const until = format.dateTime(new Date(provisional.until), {
    dateStyle: "medium",
  });
  return (
    <Banner
      testId="onboarding-provisional"
      badge={t("badge")}
      title={t("title", { workspace, until })}
      action={
        repository === null ? undefined : (
          <SafeLink
            to={routes.register(org, ws, "run")}
            className={linkText}
            data-testid="bind-main-repo"
          >
            {t("detected", {
              repository: `${repository.owner}/${repository.name}`,
            })}
          </SafeLink>
        )
      }
    >
      <p>{t("body")}</p>
      {repository === null ? <p>{t("noRepository")}</p> : null}
    </Banner>
  );
}

function FirstRun({
  runId,
  org,
  ws,
}: {
  runId: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("onboarding.gate.firstRun");
  return (
    <Banner
      testId="onboarding-first-run"
      badge={t("badge")}
      title={t("title")}
      action={
        <SafeLink to={routes.run(org, ws, runId)} className={linkText}>
          {t("open")}
        </SafeLink>
      }
    >
      <p>
        {t.rich("body", {
          run: () => <span className={mono}>{runId}</span>,
        })}
      </p>
    </Banner>
  );
}

/**
 * What the gate adds above Fleet. The rail shows while the gate is open; the
 * provisional banner shows while the window is open, whether or not the gate
 * is; the first-run banner shows once the ingest recorded the run that opened
 * it and the workspace is still provisional, which is the window in which
 * "one run so far" is true of the record the gate wrote.
 */
export async function OnboardingGate({
  ctx,
  source,
}: {
  ctx: OrgCtx | WsCtx;
  source: DataSource;
}) {
  const read = await source.onboarding.state(ctx);
  if (!read.ok) return null;
  const gate = read.value;
  const workspace = gate.workspace;
  if (workspace === null) return null;
  const org = ctx.orgSlug;
  const ws = workspace.slug;
  const provisional =
    gate.provisional !== null && gate.provisional.mainRepoBoundAt === null
      ? gate.provisional
      : null;
  const firstRunId = provisional === null ? null : gate.firstRunId;
  if (gate.step === "unlocked" && provisional === null) return null;
  return (
    <div className="flex flex-col gap-3">
      {gate.step === "unlocked" ? null : (
        <GateRail step={gate.step} org={org} ws={ws} />
      )}
      {provisional === null ? null : (
        <Provisional
          provisional={provisional}
          workspace={workspace.slug}
          org={org}
          ws={ws}
        />
      )}
      {firstRunId === null ? null : (
        <FirstRun runId={firstRunId} org={org} ws={ws} />
      )}
    </div>
  );
}
