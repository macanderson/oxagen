// The Tamper incidents section: one list_incidents page narrowed to the agent,
// newest first — what the detector recorded, when and by whom, and whether a
// person resolved it.
import { useTranslations } from "next-intl";
import type { IncidentPage } from "@/data/contracts/agents";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { mono } from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { Instant, NotRecordedValue, Pager, Panel } from "./parts";

export function IncidentsSection({
  read,
  cursor,
  org,
  ws,
  agent,
}: {
  read: Read<IncidentPage>;
  cursor: string | null;
  org: string;
  ws: string;
  agent: string;
}) {
  const t = useTranslations("agents.detail.incidents");
  if (!read.ok) {
    return (
      <Panel id="agent-incidents" title={t("title")}>
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const page = read.value;
  if (page.incidents.length === 0 && cursor === null) {
    return (
      <Panel id="agent-incidents" title={t("title")}>
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Panel>
    );
  }
  return (
    <Panel id="agent-incidents" title={t("title")}>
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.kind") },
          { label: t("columns.severity") },
          { label: t("columns.detected") },
          { label: t("columns.session") },
          { label: t("columns.state") },
        ]}
      >
        {page.incidents.map((incident) => (
          <tr key={incident.id} data-testid="incident-row">
            <td className={cell}>
              <span className={mono}>{incident.kind}</span>
            </td>
            <td className={cell} data-severity={incident.severity}>
              {t(`severity.${incident.severity}`)}
            </td>
            <td className={cell}>
              <Instant at={incident.detectedAt} />
              <span className="block text-xs text-muted-foreground">
                {t(`detectedBy.${incident.detectedBy}`)}
              </span>
            </td>
            <td className={cell}>
              {incident.sessionId === null ? (
                <NotRecordedValue />
              ) : (
                <span className={mono}>{incident.sessionId}</span>
              )}
            </td>
            <td className={cell}>
              {incident.resolvedAt === null ? (
                t("open")
              ) : (
                <>
                  {t("resolved")} <Instant at={incident.resolvedAt} />
                  {incident.resolutionNote === null ? null : (
                    <span className="block text-xs text-muted-foreground">
                      {incident.resolutionNote}
                    </span>
                  )}
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <Pager
        label={t("pager")}
        first={
          cursor === null
            ? null
            : {
                to: routes.agent(org, ws, agent, { tab: "activity" }),
                text: t("first"),
              }
        }
        next={
          page.nextCursor === null
            ? null
            : {
                to: routes.agent(org, ws, agent, {
                  tab: "activity",
                  cursor: page.nextCursor,
                }),
                text: t("next"),
              }
        }
      />
    </Panel>
  );
}
