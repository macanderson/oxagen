// The Toolbelt section (spec §6.6): the belt as get_agent_toolbelt computed
// it, never executed — how it was computed, what the model receives, the
// decision and rule per tool, and what the agent cannot see. The decision is
// the runtime pipeline's own; this section prints it and nothing stronger.
import { useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";
import type { Toolbelt } from "@/data/contracts/agents";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { Facts, Instant, NotRecordedValue, Panel } from "./parts";
import { ToolSchema } from "./tool-schema";

function Computation({ belt }: { belt: Toolbelt }) {
  const t = useTranslations("agents.detail.toolbelt");
  const locale = useLocale();
  const { computation, presentation } = belt;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel id="belt-computation" title={t("computation.title")}>
        <Facts
          rows={[
            {
              term: t("computation.computedAt"),
              value: <Instant at={belt.computedAt} />,
            },
            {
              term: t("computation.ceiling"),
              value: t(`computation.ceilingValue.${computation.humanCeiling}`),
            },
            {
              term: t("computation.roleGrants"),
              value: formatCount(computation.roleGrants, locale),
            },
            {
              term: t("computation.denyGeneration"),
              value: t("computation.denyGenerationValue", {
                org: formatCount(computation.denyGeneration.org, locale),
                workspace: formatCount(
                  computation.denyGeneration.workspace,
                  locale,
                ),
              }),
            },
            {
              term: t("computation.killSwitches"),
              value: formatCount(computation.killSwitches, locale),
            },
          ]}
        />
      </Panel>
      <Panel id="belt-presentation" title={t("presentation.title")}>
        <p className="text-sm font-medium" data-mode={presentation.mode}>
          {t(`presentation.mode.${presentation.mode}`)}
        </p>
        <p className="text-sm text-muted-foreground">
          {t(`presentation.sent.${presentation.sentToModel}`)}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("presentation.limit", {
            limit: formatCount(presentation.limit, locale),
          })}
        </p>
      </Panel>
    </div>
  );
}

function Tools({ tools }: { tools: Toolbelt["tools"] }) {
  const t = useTranslations("agents.detail.toolbelt.tools");
  return (
    <Panel id="belt-tools" title={t("title")}>
      {tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.tool") },
            { label: t("columns.category") },
            { label: t("columns.risk") },
            { label: t("columns.decision") },
            { label: t("columns.rule") },
            { label: t("columns.access") },
          ]}
        >
          {tools.map((tool) => (
            <Fragment key={tool.name}>
              <tr data-testid="belt-tool">
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
                <td className={cell}>
                  {tool.category ?? <NotRecordedValue />}
                </td>
                <td className={cell}>{t(`risk.${tool.riskLevel}`)}</td>
                <td className={cell} data-decision={tool.decision}>
                  {t(`decision.${tool.decision}`)}
                </td>
                <td className={cell}>
                  <span className={mono}>{tool.rule}</span>
                </td>
                <td className={cell}>
                  {tool.readOnly ? t("readOnly") : t("writes")}
                </td>
              </tr>
              {/*
               * The schema in a row of its own: a JSON Schema in one of six
               * columns is unreadable. On a phone the shell turns each row
               * into a labelled card (features/shell/card-tables.ts), and a
               * spanning cell takes no label, so the schema reads as a block
               * under its tool rather than a field with a wrong name.
               */}
              <tr data-testid="belt-tool-schema">
                <td className={`${cell} pt-0`} colSpan={6}>
                  <ToolSchema tool={tool} />
                </td>
              </tr>
            </Fragment>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function CannotSee({ tools }: { tools: Toolbelt["cannotSee"] }) {
  const t = useTranslations("agents.detail.toolbelt.cannotSee");
  return (
    <Panel id="belt-cannot-see" title={t("title")}>
      {tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[{ label: t("columns.tool") }, { label: t("columns.rule") }]}
        >
          {tools.map((tool) => (
            <tr key={tool.name}>
              <td className={cell}>
                <span className={`${mono} break-all`}>{tool.name}</span>
              </td>
              <td className={cell}>
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
  return (
    <div className="flex flex-col gap-4">
      <Computation belt={read.value} />
      <Tools tools={read.value.tools} />
      <CannotSee tools={read.value.cannotSee} />
    </div>
  );
}
