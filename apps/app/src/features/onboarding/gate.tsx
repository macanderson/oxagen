// The onboarding gate on Fleet (#2967, ADR-065 decision 1): the rail while the
// gate is open, and the first-run banner once the first frame opened the gate.
// There is no provisional-workspace banner: a workspace is created with its
// steering repo (#4518), so no workspace waits on a main repository.
//
// An organization that predates the gate has no row: it reads as `unlocked`
// with no first run, so nothing is drawn. A read that failed draws nothing
// either. The gate is a banner over Fleet, and Fleet's own sections report
// their own failures (§3.6).
import "server-only";
import { useTranslations } from "next-intl";
import type { OnboardingGate as Gate } from "@/data/contracts/onboarding";
import type { DataSource } from "@/data/ports";
import { type OrgCtx, WsCtx } from "@/server/viewer";
import { panel } from "@/ui/control-styles";
import { Rail, type RailStep } from "./rail";
import { FirstRunBanner } from "./ui/first-run";
import { gateRail, type GateStep } from "./steps";

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
        <p className="max-w-prose text-xs text-muted-foreground">{t("lead")}</p>
      </div>
      <Rail label={t("railLabel")} steps={steps} />
    </section>
  );
}

/**
 * The first run, when it is the only run the workspace holds: the newest
 * page of `list_runs` is that one run. A workspace with a second run is past
 * "one run so far", so the banner is not drawn, and a failed read draws
 * nothing, since Fleet reports its own runs read.
 */
async function soleFirstRun(
  ctx: WsCtx,
  source: DataSource,
  runId: string,
): Promise<{ runId: string; agentKey: string | null } | null> {
  const read = await source.runs.list(ctx, { cursor: null });
  if (!read.ok) return null;
  const [only, ...rest] = read.value.runs;
  if (only === undefined || rest.length > 0 || only.id !== runId) return null;
  return { runId: only.id, agentKey: only.agentKey };
}

/**
 * What the gate adds above Fleet. The rail shows while the gate is open. The
 * first-run banner shows on the gate's workspace once the ingest recorded the
 * run that opened it, for as long as that run is the only one the workspace
 * holds.
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
  const onPage = WsCtx.is(ctx) && ctx.wsSlug === workspace.slug ? ctx : null;
  const firstRun =
    gate.firstRunId === null || onPage === null
      ? null
      : await soleFirstRun(onPage, source, gate.firstRunId);
  if (gate.step === "unlocked" && firstRun === null) return null;
  return (
    <div className="flex flex-col gap-3">
      {gate.step === "unlocked" ? null : (
        <GateRail step={gate.step} org={org} ws={ws} />
      )}
      {firstRun === null ? null : (
        <FirstRunBanner runId={firstRun.runId} agentKey={firstRun.agentKey} />
      )}
    </div>
  );
}
