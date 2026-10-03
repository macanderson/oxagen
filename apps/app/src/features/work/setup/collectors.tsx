// Work setup › Collectors (roadmap mockups/src/work-setup.js `collectorsTab()`;
// mockups/pages/work-setup.md): one table of what Phase 1 reads. Each GitHub
// collector shows the repositories it reads, its health word beside its dot,
// its last read with what that read found, and a button that reads it again
// now. A repository the workspace no longer links is marked as skipped,
// because a collector reads only linked repositories.
//
// A collector whose last read failed adds a row under it with that read's
// answer at once, before three failures in a row turn its health to failing.
// A failing collector's row also gives its last good read and how many reads
// failed in a row. Manual entry is always on. Under the table one sentence
// says oxagen writes nothing back to GitHub.
//
// Add collector follows the collectors read's own flag, the role check
// set_work_collector makes: a workspace Owner or Admin, or an org Owner or
// Admin. Read now follows the roles sync_work_collector takes, which admit a
// workspace Member too, so a Member reads a collector now and cannot change
// one.
//
// Manual entry records no read, and an unbacked cell draws nothing
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
  linked,
  canControl,
}: {
  org: string;
  ws: string;
  collector: WorkCollector;
  /** The workspace's linked repositories, lowercased, or null when they could not be read. */
  linked: ReadonlySet<string> | null;
  /** Whether the viewer may read the collector now (sync_work_collector). */
  canControl: boolean;
}) {
  const t = useTranslations("work.setup.collectors");
  const when = useWhen();
  const failing = collector.health === "failing";
  const last = collector.lastReconcile;
  const error = last?.error ?? null;
  const lastFailed = last !== null && !last.ok;
  return (
    <>
      <tr data-collector={collector.name} data-health={collector.health}>
        <td className={cell}>
          <span className="flex flex-col">
            <span className="font-medium">{collector.name}</span>
            <span className="text-sm text-muted-foreground">{t("github")}</span>
          </span>
        </td>
        <td className={cell}>
          <ul className="flex flex-col gap-1">
            {collector.repos.map((repo) => {
              const skipped = linked !== null && !linked.has(repo.toLowerCase());
              return (
                <li
                  key={repo}
                  data-repo={repo}
                  data-linked={skipped ? "false" : undefined}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className={`${mono} [overflow-wrap:anywhere]`}>{repo}</span>
                  {skipped ? (
                    <Badge tone="denied" dot={false}>
                      {t("notLinked")}
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </td>
        <td className={cell}>
          <Badge tone={HEALTH_TONE[collector.health]} data-health={collector.health}>
            {t(`health.${collector.health}`)}
          </Badge>
        </td>
        <td className={cell} data-cell="last-read">
          {last === null ? (
            <span className="text-muted-foreground">
              {collector.health === "paused" ? t("none") : t("notReadYet")}
            </span>
          ) : (
            <span className="flex flex-col">
              <span className="whitespace-nowrap">{when(last.at)}</span>
              <span className="text-sm text-muted-foreground">
                {last.ok
                  ? t("readOk", { count: last.handled })
                  : t("readFailed")}
              </span>
            </span>
          )}
        </td>
        <td className={cell}>
          {collector.health === "paused" ? null : (
            <Reconnect org={org} ws={ws} name={collector.name} canControl={canControl} />
          )}
        </td>
      </tr>
      {failing || lastFailed ? (
        <tr data-collector-failure={collector.name}>
          <td colSpan={5} className={cell}>
            <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
              {failing ? (
                <p>
                  {collector.lastSuccessAt === null
                    ? t("neverGood")
                    : t("lastGood", { at: when(collector.lastSuccessAt) })}{" "}
                  {t("streak", { count: collector.failedStreak })}
                </p>
              ) : null}
              {error === null ? null : (
                <p className="text-foreground [overflow-wrap:anywhere]">
                  {t("error", { error })}
                </p>
              )}
              <p>{t("catchUp")}</p>
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
}: {
  org: string;
  ws: string;
  read: Read<WorkCollectorList>;
  /** Whether the viewer may read a collector now (sync_work_collector); unknown reads as allowed and the server decides. */
  canControl: boolean;
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
  const { collectors, linked, viewer } = read.value;
  const linkedSet =
    linked === null ? null : new Set(linked.map((repo) => repo.toLowerCase()));
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
          canChange={viewer.canChangeCollectors}
          collectors={collectors.map((collector) => ({
            name: collector.name,
            repos: collector.repos,
          }))}
          linked={linked}
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
          { label: t("collectors.columns.lastRead") },
          { label: t("collectors.columns.actions"), hidden: true },
        ]}
      >
        {collectors.map((collector) => (
          <CollectorRows
            key={collector.name}
            org={org}
            ws={ws}
            collector={collector}
            linked={linkedSet}
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
