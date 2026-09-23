// Gates: what gets refused (roadmap pages/steering-gates.md). The two
// compilations side by side, "Gate notices" with a row per gate that reaches
// the workspace, and the two closing notes. The tab edits nothing: each row's
// Edited on button opens the page the gate is written on.
//
// What is read today: the kill switches that are on, from list_kill_switches,
// the one gate source a person can read. Decision rules, mandate gates and
// the gates a record's enforcement grant compiles have no read, and no code
// writes the one-line gate notice or its token cost for any gate (#3880). So
// those rows are left out under a NotBacked panel naming the issue, and a
// switch's Gate notice and Notice cost print "not recorded". For the same
// reason the tab never draws "No gate applies to this workspace yet": with
// decision rules unread, the page cannot know that no gate applies.
//
// The workspace's two freshness gates stay under the spec's panels, with the
// switches that set them: refusing a prompt on stale steering is a gate, and
// this is the one page that sets it.
import { useTranslations } from "next-intl";
import type { KillSwitch, KillSwitchBoard } from "@/data/contracts/tools";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, panelBody } from "@/ui/control-styles";
import { ListTable, type ListRow } from "@/ui/faceted-list-table";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell } from "@/ui/table";
import { Freshness } from "../freshness";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";
import { SteeringReadFailure } from "../read-failure";
import { code, Note, TabPanel, Unrecorded } from "../tab-parts";
import type { SteeringAt } from "../view";

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

/** The switches that refuse right now: a cleared switch reaches no agent. */
export function gatesOf(board: KillSwitchBoard): KillSwitch[] {
  return board.switches.filter((s) => s.on);
}

export async function GatesTab({
  ctx,
  source,
  at,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
}) {
  const [switches, freshness] = await Promise.all([
    source.tools.killSwitches(ctx),
    source.steering.freshness(ctx),
  ]);
  return (
    <GatesBody ctx={ctx} at={at} switches={switches} freshness={freshness} />
  );
}

function Planes() {
  const t = useTranslations("steering.bodies.gates");
  return (
    <div className="grid gap-3.5 md:grid-cols-2" data-testid="gates-planes">
      <TabPanel id="gates-text" title={t("textTitle")}>
        <p className={`${panelBody} text-[13px] text-muted-foreground`}>
          {t("textBody")}
        </p>
      </TabPanel>
      <TabPanel id="gates-gate" title={t("gateTitle")}>
        <p className={`${panelBody} text-[13px] text-muted-foreground`}>
          {t("gateBody")}
        </p>
      </TabPanel>
    </div>
  );
}

function Notices({
  at,
  wsName,
  read,
}: {
  at: SteeringAt;
  wsName: string;
  read: Read<KillSwitchBoard>;
}) {
  const t = useTranslations("steering.bodies.gates");
  const title = t("noticesTitle");
  const closing = (
    <>
      <Note testId="gates-closing">{t("closing")}</Note>
      <Note testId="gates-tiers">{t.rich("tiers", { code })}</Note>
    </>
  );
  if (!read.ok) {
    return (
      <TabPanel id="gates-notices" title={title} testId="gates-notices">
        <div className={`${panelBody} flex flex-col gap-2.5`}>
          <SteeringReadFailure read={read} section={title} />
          {closing}
        </div>
      </TabPanel>
    );
  }
  const gates = gatesOf(read.value);
  const unrecorded = <Unrecorded issue={STEERING_GAPS.gates} />;
  const edit = t("editSwitches");
  const outcome = t("outcomes.killSwitch");
  const rows: ListRow[] = gates.map((gate) => {
    const applies = t(`applies.${gate.target.kind}`, {
      ref: gate.target.ref,
      workspace: wsName,
    });
    return {
      key: gate.id,
      values: {
        gate: `${t("kinds.killSwitch")} ${gate.id}`,
        outcome,
        applies,
        notice: null,
        cost: null,
        edit,
      },
      node: (
        <tr key={gate.id} data-gate={gate.id}>
          <td className={cell}>
            <b className="block font-semibold text-foreground">
              {t("kinds.killSwitch")}
            </b>
            <span className="block font-mono text-[11.5px] text-muted-foreground">
              {gate.id}
            </span>
          </td>
          <td className={cell}>
            <Badge tone="failed" data-outcome="kill switch">
              {outcome}
            </Badge>
          </td>
          <td className={`${cell} text-[12.5px]`}>{applies}</td>
          <td className={cell} data-cell="notice">
            {unrecorded}
          </td>
          <td className={numericCell} data-cell="cost">
            {unrecorded}
          </td>
          <td className={cell}>
            <SafeLink
              to={routes.tools(at.org, at.ws, { tab: "switches" })}
              className={buttonSecondary}
            >
              {edit}
            </SafeLink>
          </td>
        </tr>
      ),
    };
  });
  return (
    <TabPanel
      id="gates-notices"
      title={title}
      testId="gates-notices"
      badge={
        <Badge tone="quiet" dot={false} data-testid="gates-count">
          {gates.length}
        </Badge>
      }
    >
      {gates.length === 0 ? (
        <p
          className={`${panelBody} text-[13px] text-muted-foreground`}
          data-state="no-switch"
        >
          {t("noSwitch")}
        </p>
      ) : (
        <ListTable
          testId="gates-list"
          label={title}
          columns={[
            { key: "gate", label: t("columns.gate") },
            { key: "outcome", label: t("columns.outcome") },
            { key: "applies", label: t("columns.applies") },
            { key: "notice", label: t("columns.notice") },
            { key: "cost", label: t("columns.cost"), numeric: true },
            { key: "edit", label: t("columns.edit") },
          ]}
          filters={["outcome", "edit"]}
          rows={rows}
        />
      )}
      <div
        className={`${panelBody} flex flex-col gap-2.5 border-t border-border`}
      >
        {read.value.truncated ? (
          <Note testId="gates-truncated">{t("truncated")}</Note>
        ) : null}
        {closing}
      </div>
    </TabPanel>
  );
}

function GatesBody({
  ctx,
  at,
  switches,
  freshness,
}: {
  ctx: WsCtx;
  at: SteeringAt;
  switches: Read<KillSwitchBoard>;
  freshness: Awaited<ReturnType<DataSource["steering"]["freshness"]>>;
}) {
  const t = useTranslations("steering");
  return (
    <div className="flex flex-col gap-3.5" data-testid="tab-gates">
      <Planes />
      <NotBacked
        testId="gates-not-backed"
        what={t("bodies.gates.what")}
        issue={STEERING_GAPS.gates}
      />
      <Notices at={at} wsName={ctx.wsSlug} read={switches} />
      {freshness.ok ? (
        <Freshness at={at} read={freshness.value} canEdit={canEditGates(ctx)} />
      ) : (
        <SteeringReadFailure read={freshness} section={t("freshness.title")} />
      )}
    </div>
  );
}
