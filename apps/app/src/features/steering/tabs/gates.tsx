// Gates: what gets refused (roadmap pages/steering.md; the tab body is
// pages/steering-gates.md, which the steering-tabs lane builds). The
// workspace's two freshness gates live here, because refusing a prompt on
// stale steering is a gate; the gates a decision rule, a mandate or a kill
// switch puts into steering wait on their read.
import { useTranslations } from "next-intl";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { Freshness } from "../freshness";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";
import { SteeringReadFailure } from "../read-failure";

/**
 * Who may set the freshness gates, mirroring `update_workspace_settings`'s own
 * gate (INV-29): an org Owner or Admin, or the Owner or Admin of this
 * workspace. The handler decides; this only stops the page offering a
 * checkbox that would come back `denied`.
 */
function canEditGates(ctx: WsCtx): boolean {
  const admin = (role: string) => role === "owner" || role === "admin";
  return admin(ctx.orgRole) || admin(ctx.wsRole);
}

export async function GatesTab({
  ctx,
  source,
}: {
  ctx: WsCtx;
  source: DataSource;
}) {
  const read = await source.steering.freshness(ctx);
  return <GatesBody ctx={ctx} read={read} />;
}

function GatesBody({
  ctx,
  read,
}: {
  ctx: WsCtx;
  read: Awaited<ReturnType<DataSource["steering"]["freshness"]>>;
}) {
  const t = useTranslations("steering");
  return (
    <div className="flex flex-col gap-4" data-testid="tab-gates">
      <NotBacked
        testId="gates-not-backed"
        what={t("bodies.gates.what")}
        issue={STEERING_GAPS.gates}
      />
      {read.ok ? (
        <Freshness
          at={{ org: ctx.orgSlug, ws: ctx.wsSlug }}
          read={read.value}
          canEdit={canEditGates(ctx)}
        />
      ) : (
        <SteeringReadFailure read={read} section={t("freshness.title")} />
      )}
    </div>
  );
}
