// Steering (spec pages/agent.md, Steering): the agent-scoped view of the
// workspace library. Nothing is authored here; every write lands on Steering.
//
// What the record holds for one agent is the steering manifest each wrapped
// run wrote (`get_steering_deliveries`): how many records were included and
// cut, and the token budget against what was spent. The item list the design
// draws, the stable prefix in bytes and the reasons each cut record gives are
// not recorded per agent (the assembler has no per-agent registry port yet),
// so those say so rather than showing the workspace library as if it were
// this agent's. The newest manifest of this agent is the one shown.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunRow } from "@/data/contracts/runs";
import type { SteeringDeliveries } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { formatCount, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { NotBacked, Note, Panel } from "./parts";
import { StubAction } from "./stub-action";

type Manifest = SteeringDeliveries["runs"][number];

/** The newest manifest a run of this agent wrote, or null. */
function manifestOf(
  deliveries: SteeringDeliveries,
  agentKey: string | null,
): Manifest | null {
  if (agentKey === null) return null;
  const mine = deliveries.runs.filter((run) => run.agentKey === agentKey);
  mine.sort((a, b) => b.ts.localeCompare(a.ts));
  return mine[0] ?? null;
}

function Meter({
  id,
  label,
  sub,
  children,
}: {
  id: string;
  label: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5"
    >
      <div className="flex flex-col">
        <h2 id={id} className="text-[13px] font-semibold">
          {label}
        </h2>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      {children}
    </section>
  );
}

const ITEM_COLUMNS = [
  "item",
  "kind",
  "force",
  "scope",
  "body",
  "source",
  "lands",
  "cost",
] as const;
const CUT_COLUMNS = [
  "item",
  "kind",
  "force",
  "cost",
  "because",
  "why",
] as const;

export function SteeringSection({
  deliveries,
  agentKey,
  lastRun,
  org,
  ws,
}: {
  deliveries: Read<SteeringDeliveries>;
  agentKey: string | null;
  lastRun: RunRow | null;
  org: string;
  ws: string;
}) {
  const t = useTranslations("agents.detail.steering");
  const locale = useLocale();
  const n = (value: number) => formatCount(value, locale);
  if (!deliveries.ok) {
    return (
      <Panel id="agent-steering" title={t("reaches.title")}>
        <ReadFailure read={deliveries} section={t("reaches.title")} />
      </Panel>
    );
  }
  const manifest = manifestOf(deliveries.value, agentKey);
  if (manifest === null) {
    return (
      <Panel
        id="agent-steering"
        title={t("empty.title")}
        testId="steering-empty"
      >
        <p className="text-[12.5px] text-muted-foreground">{t("empty.body")}</p>
        <SafeLink
          to={routes.steering(org, ws)}
          className={`${buttonSecondary} self-start`}
        >
          {t("library")}
        </SafeLink>
      </Panel>
    );
  }
  const budget = manifest.budgetTokens;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-steering-tab">
      {lastRun?.enforcementTier === "observe" ? (
        <p
          role="note"
          data-testid="steering-observe"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]"
        >
          <b>{t("observe.lead")}</b> {t("observe.body")}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Meter
          id="steering-prefix"
          label={t("prefix.label")}
          sub={t("prefix.sub")}
        >
          <NotBacked gap="steering_prefix_bytes">
            {t("prefix.notBacked")}
          </NotBacked>
        </Meter>
        <Meter
          id="steering-volatile"
          label={t("volatile.label")}
          sub={t("volatile.sub")}
        >
          <p className="flex justify-between gap-3 text-[13px]">
            <span className={`${mono} text-xs text-muted-foreground`}>
              {manifest.ts}
            </span>
            <b className={mono} data-testid="steering-budget">
              {t("volatile.value", {
                spent: n(manifest.spentTokens),
                budget: n(budget),
              })}
            </b>
          </p>
          <span
            aria-hidden="true"
            className="block h-1.5 overflow-hidden rounded-full bg-hl"
          >
            <span
              className="block h-full rounded-full bg-foreground/70"
              style={{
                width: ratioWidth(
                  budget === 0 ? 0 : manifest.spentTokens / budget,
                ),
              }}
            />
          </span>
          <p className="text-xs text-muted-foreground">
            {t("volatile.note", {
              included: n(manifest.recordsIncluded),
              cut: n(manifest.recordsCut),
            })}
          </p>
        </Meter>
      </div>
      <Panel
        id="agent-steering-reaches"
        title={t("reaches.title")}
        lead={t("reaches.lead", {
          items: n(manifest.recordsIncluded),
          tokens: n(manifest.spentTokens),
        })}
        aside={
          <>
            <SafeLink to={routes.steering(org, ws)} className={buttonSecondary}>
              {t("reaches.assigned")}
            </SafeLink>
            <StubAction
              label={t("reaches.compiler.open")}
              title={t("reaches.compiler.title")}
              body={t("reaches.compiler.body")}
              gap="steering_compiler"
              testId="open-compiler"
            />
          </>
        }
      >
        <Table
          label={t("reaches.title")}
          columns={ITEM_COLUMNS.map((c) => ({
            label: t(`reaches.columns.${c}`),
            numeric: c === "cost",
          }))}
        >
          <tr>
            <td className={cell} colSpan={ITEM_COLUMNS.length}>
              <NotBacked gap="steering_agent_assembly">
                {t("reaches.notBacked")}
              </NotBacked>
            </td>
          </tr>
        </Table>
        <Note>{t("reaches.note")}</Note>
      </Panel>
      <Panel
        id="agent-steering-cut"
        title={t("cut.title")}
        aside={
          <Badge tone="quiet" dot={false}>
            {t("cut.badge", { count: n(manifest.recordsCut) })}
          </Badge>
        }
      >
        <Table
          label={t("cut.title")}
          columns={CUT_COLUMNS.map((c) => ({
            label: t(`cut.columns.${c}`),
            numeric: c === "cost",
          }))}
        >
          <tr>
            <td className={cell} colSpan={CUT_COLUMNS.length}>
              <NotBacked gap="steering_agent_assembly">
                {t("cut.notBacked", {
                  budget: n(manifest.recordsCutForBudget),
                })}
              </NotBacked>
            </td>
          </tr>
        </Table>
      </Panel>
    </div>
  );
}
