// Toolbelt (spec pages/agent.md, Toolbelt; spec §6.6): the only tool list the
// model is ever shown, as `get_agent_toolbelt` computed it, never executed.
// Five panels in the design's order: how the belt was computed, the model
// view, the belt search, the per-tool decision rules, and what is off the
// belt. The decision is the runtime pipeline's own, and this tab prints it
// and nothing stronger. It never claims a permission: a belt decides what the
// model is shown, and Permissions decides whether the call survives.
//
// What the computation does not record says so: the active policy bundle has
// no version on the contract, and a tool's egress and financial class are not
// on the belt entry. The toolbelt as a stored, assignable object does not
// exist yet, so the belt here is the computed one.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Toolbelt } from "@/data/contracts/agents";
import type { Read } from "@/data/read";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { Instant, NotRecordedValue, Panel } from "./parts";
import { BeltSearch, DecisionRules, ModelView } from "./toolbelt-views";

function WireNode({
  label,
  value,
  belt = false,
}: {
  label: string;
  value: ReactNode;
  belt?: boolean;
}) {
  return (
    <li
      className={`flex min-w-0 flex-col rounded-lg border px-3 py-2 text-[13px] ${belt ? "border-gold/50 bg-gold/10" : "border-border bg-hl"}`}
    >
      <span>{label}</span>
      <span className="text-xs text-dim">{value}</span>
    </li>
  );
}

function Computation({ belt }: { belt: Toolbelt }) {
  const t = useTranslations("agents.detail.toolbelt.computation");
  const locale = useLocale();
  const n = (value: number) => formatCount(value, locale);
  const { computation } = belt;
  return (
    <Panel
      id="belt-computation"
      title={t("title")}
      lead={t("lead")}
      aside={
        <Badge tone="quiet" dot={false} mono>
          {t("denyGen", {
            org: n(computation.denyGeneration.org),
            workspace: n(computation.denyGeneration.workspace),
          })}
        </Badge>
      }
    >
      <ol
        aria-label={t("wire")}
        className="flex flex-wrap items-center gap-2"
        data-testid="belt-wire"
      >
        <WireNode
          label={t("grants")}
          value={t("grantsValue", { count: n(computation.roleGrants) })}
        />
        <WireNode
          label={t("ceiling")}
          value={t(`ceilingValue.${computation.humanCeiling}`)}
        />
        <WireNode label={t("policy")} value={<NotRecordedValue />} />
        <WireNode
          label={t("switches")}
          value={t("switchesValue", { count: n(computation.killSwitches) })}
        />
        <WireNode
          belt
          label={t("belt")}
          value={t("beltValue", { count: n(belt.tools.length) })}
        />
      </ol>
      <p className="text-[13px]">
        {t("body", {
          count: n(belt.tools.length),
          off: n(belt.cannotSee.length),
        })}{" "}
        <span className="text-muted-foreground">
          {t("computedAt")} <Instant at={belt.computedAt} />
        </span>
      </p>
    </Panel>
  );
}

function OffTheBelt({ tools }: { tools: Toolbelt["cannotSee"] }) {
  const t = useTranslations("agents.detail.toolbelt.off");
  return (
    <Panel
      id="belt-off"
      title={t("title")}
      lead={t("lead")}
      aside={<Badge tone="denied">{t("badge")}</Badge>}
    >
      {tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.tool") },
            { label: t("columns.reason") },
          ]}
        >
          {tools.map((tool) => (
            <tr key={tool.name} data-testid="belt-off-row">
              <td className={cell}>
                <span className={`${mono} break-all`}>{tool.name}</span>
                {tool.server === null ? null : (
                  <span
                    className={`${mono} block text-xs text-muted-foreground`}
                  >
                    {tool.server}
                  </span>
                )}
              </td>
              <td className={`${cell} text-muted-foreground`}>
                <span className={mono}>{tool.rule}</span>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function ToolbeltSection({ read }: { read: Read<Toolbelt> }) {
  const t = useTranslations("agents.detail.toolbelt");
  if (!read.ok) {
    return (
      <Panel id="belt-failure" title={t("title")}>
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const belt = read.value;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-toolbelt-tab">
      <Computation belt={belt} />
      <ModelView belt={belt} />
      <BeltSearch belt={belt} />
      <DecisionRules belt={belt} />
      <OffTheBelt tools={belt.cannotSee} />
    </div>
  );
}
