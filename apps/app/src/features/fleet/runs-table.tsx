import { HarnessIcon } from "@/ui/harness-icon";
import { useLocale, useTranslations } from "next-intl";
import { useFormatter } from "@/ui/formatter";
import type { RunPage } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import {
  linkText,
  mono,
  panel,
  panelHeader,
  panelFooter,
} from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { GeneratedSummary } from "@/ui/generated-summary";
import { StatusBadge } from "@/ui/status-badge";
import { cell, numericCell, Table } from "@/ui/table";
import { ReadFailure } from "@/ui/read-failure";
import { RunRowControls } from "./run-row-controls";

type Place = { org: string; ws: string };

function EmptyRuns({ workspace }: { workspace: string }) {
  const t = useTranslations("fleet.runs.empty");
  return (
    <div
      data-testid="runs-empty"
      className="flex flex-col items-center gap-2 py-6 text-center text-sm"
    >
      <h3 className="font-semibold">{t("title", { workspace })}</h3>
      <p className="max-w-prose text-muted-foreground">{t("body")}</p>
      <p className="max-w-prose text-muted-foreground">{t("enroll")}</p>
      <code className={`${mono} rounded-md bg-muted px-2 py-1`}>
        {t("command")}
      </code>
    </div>
  );
}

function RunsPageView({
  page,
  cursor,
  org,
  ws,
  canCommand,
}: {
  page: RunPage;
  cursor: string | null;
  canCommand: boolean;
} & Place) {
  const t = useTranslations("fleet.runs");
  const format = useFormatter();
  const locale = useLocale();
  const notRecorded = (
    <span className="text-muted-foreground">{t("notRecorded")}</span>
  );
  // A run whose record holds no cost is one no total over this column covers
  // (#3304). The page counts the rows it drew rather than naming a harness:
  // the row says whether a figure was recorded, not who failed to report one.
  const unpriced = page.runs.filter((run) => run.cost === null).length;
  const columns = [
    { label: t("columns.run") },
    { label: t("columns.agent") },
    { label: t("columns.operator") },
    { label: t("columns.status") },
    { label: t("columns.tier") },
    { label: t("columns.cost"), numeric: true },
    { label: t("columns.frames"), numeric: true },
    { label: t("columns.started") },
    { label: t("columns.controls") },
  ];
  return (
    <>
      <Table label={t("title")} columns={columns}>
        {page.runs.map((run) => (
          <tr key={run.id} data-testid="run-row">
            <td className={`${cell} min-w-64 max-w-80`}>
              <SafeLink
                to={routes.run(org, ws, run.id)}
                className={`${linkText} block truncate font-medium`}
                title={run.name ?? run.taskRef ?? run.id}
              >
                {run.name ?? run.taskRef ?? t("unnamedRun")}
              </SafeLink>
              <span
                className={`block truncate text-[10px] text-muted-foreground ${mono}`}
              >
                {run.id}
              </span>
              {run.taskRef === null ? null : (
                <span className="block text-xs text-muted-foreground">
                  {run.taskRef}
                </span>
              )}
              {run.summary === null ? null : (
                <div className="mt-1">
                  <GeneratedSummary summary={run.summary} />
                </div>
              )}
            </td>
            <td className={`${cell} min-w-48 max-w-60`}>
              <AgentCard
                agentKey={run.agentKey}
                notRecorded={t("notRecorded")}
                sub={t(`source.${run.source}`)}
              />
              {run.harness && (
                <span className="mt-1 inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <HarnessIcon
                    harness={run.harness.runtime ?? run.harness.name}
                    size={16}
                  />
                  <span>
                    {run.harness.name}
                    {run.harness.version ? ` ${run.harness.version}` : ""}
                  </span>
                </span>
              )}
            </td>
            <td className={`${cell} min-w-36 whitespace-nowrap`}>
              {run.operatorId === null && run.operatorName === null ? (
                notRecorded
              ) : (
                <OperatorName
                  operator={{
                    id: run.operatorId,
                    name: run.operatorName,
                    kind: run.operatorKind,
                  }}
                >
                  {run.operatorName ??
                    (run.operatorKind === null ? (
                      // An id with no name and no kind is still a recorded
                      // operator: the id is the label, never "not recorded".
                      <span className={mono}>{run.operatorId}</span>
                    ) : (
                      t(`operatorKind.${run.operatorKind}`)
                    ))}
                </OperatorName>
              )}
            </td>
            <td className={cell}>
              <StatusBadge status={run.status} outcome={run.outcome} />
            </td>
            <td className={cell}>
              <EnforcementTierBadge tier={run.enforcementTier} />
            </td>
            <td className={`${numericCell} whitespace-nowrap`}>
              {run.cost === null ? (
                notRecorded
              ) : (
                <>
                  <Money value={run.cost} />
                  <span className="block font-mono text-[10.5px] text-muted-foreground">
                    {run.cost.basis ?? t("basisNotRecorded")}
                  </span>
                </>
              )}
            </td>
            <td className={`${numericCell} whitespace-nowrap`}>
              {formatCount(run.frames, locale)}
            </td>
            <td
              className={`${cell} whitespace-nowrap text-xs text-muted-foreground`}
            >
              <time dateTime={run.startedAt}>
                {format.dateTime(new Date(run.startedAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </td>
            <td className={`${cell} min-w-36 max-w-56`}>
              <RunRowControls
                org={org}
                ws={ws}
                runId={run.id}
                status={run.status}
                source={run.source}
                enforcementTier={run.enforcementTier}
                canCommand={canCommand}
              />
            </td>
          </tr>
        ))}
      </Table>
      <footer className={panelFooter}>
        <span>
          {t("rowsShown", { count: formatCount(page.runs.length, locale) })}
        </span>
        {unpriced === 0 ? null : (
          <p
            data-testid="runs-unpriced"
            className="max-w-prose pt-1 text-xs text-muted-foreground"
          >
            {t("unpriced", { count: unpriced })}{" "}
            <SafeLink
              to={routes.spend(org, ws, { tab: "findings" })}
              className={linkText}
            >
              {t("unpricedLink")}
            </SafeLink>
          </p>
        )}
        {page.nextCursor === null && cursor === null ? null : (
          <nav aria-label={t("pager")} className="flex gap-4 pt-3 text-sm">
            {cursor === null ? null : (
              <SafeLink to={routes.fleet(org, ws)} className={linkText}>
                {t("newest")}
              </SafeLink>
            )}
            {page.nextCursor === null ? null : (
              <SafeLink
                to={routes.fleet(org, ws, { cursor: page.nextCursor })}
                className={linkText}
              >
                {t("older")}
              </SafeLink>
            )}
          </nav>
        )}
      </footer>
    </>
  );
}

export function RunsTable({
  runs,
  cursor,
  workspace,
  org,
  ws,
  canCommand,
}: {
  runs: Read<RunPage>;
  cursor: string | null;
  /** The workspace's display name, for the empty state. */
  workspace: string;
  /** Whether `dispatch_command` admits this viewer, resolved once for the page. */
  canCommand: boolean;
} & Place) {
  const t = useTranslations("fleet.runs");
  return (
    <section aria-labelledby="fleet-runs" className={panel}>
      <h2 id="fleet-runs" className={`${panelHeader} text-sm font-semibold`}>
        {t("title")}
      </h2>
      {!runs.ok ? (
        <ReadFailure read={runs} section={t("title")} />
      ) : runs.value.runs.length === 0 && cursor === null ? (
        <EmptyRuns workspace={workspace} />
      ) : (
        <RunsPageView
          page={runs.value}
          cursor={cursor}
          org={org}
          ws={ws}
          canCommand={canCommand}
        />
      )}
    </section>
  );
}
