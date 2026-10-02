// Work setup › Collectors (roadmap mockups/src/work-setup.js `collectorsTab()`;
// mockups/pages/work-setup.md): one table of what Phase 1 reads. Each GitHub
// collector shows the repositories it reads, its health word beside its dot,
// and its last event. A failing collector adds a row under it with its last
// good read, how many reads failed in a row, what the last read answered, and
// a button that reads it again. Manual entry is always on. Under the table one
// sentence says oxagen writes nothing back to GitHub.
//
// Manual entry records no last event, and an unbacked cell draws nothing
// (data/unrecorded.ts).
import { useTranslations } from "next-intl";
import type { WorkCollector, WorkCollectorList } from "@/data/contracts/work";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { cell, Table } from "@/ui/table";
import { WorkReadFailure } from "../read-failure";
import { AddCollector } from "./add-collector";
import { Reconnect } from "./reconnect";

const HEALTH_TONE: Record<WorkCollector["health"], BadgeTone> = {
  healthy: "allowed",
  lagging: "approval",
  failing: "failed",
  paused: "quiet",
};

function useWhen(): (at: string) => string {
  const format = useFormatter();
  return (at) =>
    format.dateTime(new Date(at), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
}

function CollectorRows({
  org,
  ws,
  collector,
  canControl,
}: {
  org: string;
  ws: string;
  collector: WorkCollector;
  canControl: boolean;
}) {
  const t = useTranslations("work.setup.collectors");
  const when = useWhen();
  const failing = collector.health === "failing";
  const error = collector.lastReconcile?.error ?? null;
  return (
    <>
      <tr data-collector={collector.name} data-health={collector.health}>
        <td className={cell}>
          <span className="flex flex-col">
            <span className="font-medium">{collector.name}</span>
            <span className="text-sm text-muted-foreground">
              {t("github")}
            </span>
          </span>
        </td>
        <td className={cell}>
          <ul className="flex flex-col">
            {collector.repos.map((repo) => (
              <li key={repo} className={mono}>
                {repo}
              </li>
            ))}
          </ul>
        </td>
        <td className={cell}>
          <Badge tone={HEALTH_TONE[collector.health]} data-health={collector.health}>
            {t(`health.${collector.health}`)}
          </Badge>
        </td>
        <td className={`${cell} whitespace-nowrap`}>
          {collector.lastEventAt === null ? (
            <span className="text-muted-foreground">{t("none")}</span>
          ) : (
            when(collector.lastEventAt)
          )}
        </td>
      </tr>
      {failing ? (
        <tr data-collector-failure={collector.name}>
          <td colSpan={4} className={cell}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex min-w-0 grow basis-72 flex-col gap-1 text-sm text-muted-foreground">
                <p>
                  {collector.lastSuccessAt === null
                    ? t("neverGood")
                    : t("lastGood", { at: when(collector.lastSuccessAt) })}{" "}
                  {t("streak", { count: collector.failedStreak })}
                </p>
                {error === null ? null : (
                  <p className="[overflow-wrap:anywhere]">
                    {t("error", { error })}
                  </p>
                )}
                <p>{t("catchUp")}</p>
              </div>
              <Reconnect
                org={org}
                ws={ws}
                name={collector.name}
                canControl={canControl}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function CollectorsTab({
  org,
  ws,
  read,
  canControl,
  connections,
}: {
  org: string;
  ws: string;
  read: Read<WorkCollectorList>;
  /** Whether the viewer may change collectors; unknown reads as allowed and the server decides. */
  canControl: boolean;
  /** The connected GitHub accounts, or null when they could not be read. */
  connections: readonly { readonly id: string; readonly name: string }[] | null;
}) {
  const t = useTranslations("work.setup");
  if (!read.ok)
    return (
      <WorkReadFailure
        read={read}
        page={t("tabs.collectors")}
        retry={routes.workSetup(org, ws, "collectors")}
      />
    );
  const collectors = read.value.collectors;
  return (
    <section
      aria-labelledby="work-collectors-title"
      data-testid="work-collectors"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-collectors-title" className={panelTitle}>
          {t("tabs.collectors")}
        </h2>
        <AddCollector
          org={org}
          ws={ws}
          canControl={canControl}
          collectors={collectors.map((collector) => collector.name)}
          connections={connections}
        />
      </div>
      {collectors.length === 0 ? (
        <p
          data-testid="work-collectors-empty"
          className={`${panelBody} text-sm text-muted-foreground`}
        >
          {t("collectors.empty")}
        </p>
      ) : null}
      <Table
        label={t("tabs.collectors")}
        columns={[
          { label: t("collectors.columns.collector") },
          { label: t("collectors.columns.reads") },
          { label: t("collectors.columns.health") },
          { label: t("collectors.columns.lastEvent") },
        ]}
      >
        {collectors.map((collector) => (
          <CollectorRows
            key={collector.name}
            org={org}
            ws={ws}
            collector={collector}
            canControl={canControl}
          />
        ))}
        <tr data-collector="manual">
          <td className={cell}>
            <span className="font-medium">{t("collectors.manual")}</span>
          </td>
          <td className={cell}>{t("collectors.manualReads")}</td>
          <td className={cell}>
            <Badge tone="allowed">{t("collectors.manualOn")}</Badge>
          </td>
          <td className={cell} />
        </tr>
      </Table>
      <div className={`${panelBody} border-t border-border`}>
        <p
          data-testid="work-write-back"
          className="text-sm text-muted-foreground"
        >
          {t("collectors.writeBack")}
        </p>
      </div>
    </section>
  );
}
