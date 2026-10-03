// Activity (spec pages/agent.md, Activity): what this agent did. Its runs on
// the newest page of the run index, the 30-day token accounting by class, the
// last 30 days with any finding open against it, and every incident the
// collector or the control plane recorded against it.
//
// Every figure is read from a record: the runs from `list_runs`, the tokens
// and spend from this agent's row of `get_spend`, the findings from
// `list_findings` read by this agent's key (#5303), and the incidents from
// `list_incidents` narrowed to the agent, one cursor page at the size Rows
// picks (#4693). A run's own token count, a class's rate and cost, and the
// tool-definition share of input are not recorded yet (G3), so they say so.
import { TAMPER_INCIDENT_KINDS } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { useLocale, useTranslations } from "next-intl";
import type { IncidentPage } from "@/data/contracts/agents";
import type { RunRow } from "@/data/contracts/runs";
import type { SpendFindings } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono, panel } from "@/ui/control-styles";
import { LinkPager } from "@/ui/link-pager";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { StatusBadge } from "@/ui/status-badge";
import { cell, numericCell, Table } from "@/ui/table";
import { type AgentRunRows, INCIDENT_PAGE, INCIDENT_ROWS } from "./agent-reads";
import {
  Facts,
  Instant,
  NotBacked,
  NotRecordedValue,
  Note,
  Panel,
  Sub,
} from "./parts";
import { type AgentSpendRow, tokenRollup } from "./tokens";

type Place = { org: string; ws: string; agent: string };

function Runs({
  runs,
  row,
  place,
}: {
  runs: Read<AgentRunRows>;
  row: AgentSpendRow | null;
  place: Place;
}) {
  const t = useTranslations("agents.detail.activity.runs");
  const locale = useLocale();
  if (!runs.ok) {
    return (
      <Panel id="agent-runs" title={t("title")}>
        <ReadFailure read={runs} section={t("title")} />
      </Panel>
    );
  }
  if (runs.value.length === 0) {
    return (
      <Panel id="agent-runs" title={t("title")} testId="runs-empty">
        <p className="text-sm text-muted-foreground">
          {row === null
            ? t("emptyNoRollup")
            : t("empty", { count: formatCount(row.runs, locale) })}
        </p>
        <SafeLink
          to={routes.audit(place.org)}
          className={`${buttonSecondary} self-start`}
        >
          {t("audit")}
        </SafeLink>
      </Panel>
    );
  }
  return (
    <Panel
      id="agent-runs"
      title={t("title")}
      aside={
        <span className={`${mono} text-sm text-dim`}>
          {t("shown", { count: formatCount(runs.value.length, locale) })}
        </span>
      }
    >
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.run") },
          { label: t("columns.status") },
          { label: t("columns.tokens"), numeric: true },
          { label: t("columns.cost"), numeric: true },
          { label: t("columns.frames"), numeric: true },
          { label: t("columns.started") },
        ]}
      >
        {runs.value.map((run: RunRow) => (
          <tr key={run.id} data-testid="agent-run">
            <td className={cell}>
              {/* #4571: the session name leads, as on Fleet, with the id
                  on the line below it. */}
              <SafeLink
                to={routes.run(place.org, place.ws, run.id)}
                title={run.name ?? run.taskRef ?? undefined}
                className="block truncate text-xs underline-offset-4 hover:underline"
              >
                {run.name ?? run.taskRef ?? t("untitled")}
              </SafeLink>
              <span
                data-testid="agent-run-id"
                className={`${mono} block truncate text-sm text-dim`}
              >
                {run.id}
              </span>
            </td>
            <td className={cell}>
              <StatusBadge status={run.status} outcome={run.outcome} />
            </td>
            <td className={numericCell}>
              <NotRecordedValue />
            </td>
            <td className={numericCell}>
              {run.cost === null ? (
                <NotRecordedValue />
              ) : (
                <Money value={run.cost} />
              )}
            </td>
            <td className={numericCell}>{formatCount(run.frames, locale)}</td>
            <td className={`${cell} ${mono} text-xs text-dim`}>
              <Instant at={run.startedAt} />
            </td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

const ACCOUNTING = [
  "inputUncached",
  "cacheWrite",
  "cacheRead",
  "output",
  "reasoning",
] as const;

function Accounting({
  row,
  spend,
}: {
  row: AgentSpendRow | null;
  spend: Read<unknown> | null;
}) {
  const t = useTranslations("agents.detail.activity.accounting");
  const locale = useLocale();
  const r = row === null ? null : tokenRollup(row);
  return (
    <Panel
      id="agent-accounting"
      title={t("title")}
      lead={t("lead")}
      aside={
        <span className={`${mono} text-sm text-dim`}>{t("window")}</span>
      }
    >
      {spend !== null && !spend.ok ? (
        <ReadFailure read={spend} section={t("title")} />
      ) : r === null ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <>
          <Table
            label={t("title")}
            columns={[
              { label: t("columns.class") },
              { label: t("columns.tokens"), numeric: true },
              { label: t("columns.rate"), numeric: true },
              { label: t("columns.cost"), numeric: true },
            ]}
          >
            {ACCOUNTING.map((key) => (
              <tr key={key} data-class={key}>
                <td className={cell}>{t(`classes.${key}`)}</td>
                <td className={numericCell}>{formatCount(r[key], locale)}</td>
                <td className={numericCell}>
                  <NotRecordedValue />
                </td>
                <td className={numericCell}>
                  <NotRecordedValue />
                </td>
              </tr>
            ))}
            <tr data-class="toolDefinitions">
              <td className={cell}>{t("classes.toolDefinitions")}</td>
              <td className={numericCell}>
                <NotRecordedValue />
              </td>
              <td className={`${numericCell} text-dim`}>
                {t("countedAsInput")}
              </td>
              <td className={numericCell}>
                <NotRecordedValue />
              </td>
            </tr>
          </Table>
          <Note>
            {r.cacheRate === null
              ? t("noteNoCache")
              : t("note", { rate: formatRatio(r.cacheRate, locale) })}
          </Note>
          <NotBacked gap="G3">{t("notBacked")}</NotBacked>
        </>
      )}
    </Panel>
  );
}

function Last30({
  row,
  findings,
  agentKey,
  place,
}: {
  row: AgentSpendRow | null;
  findings: Read<SpendFindings> | null;
  agentKey: string | null;
  place: Place;
}) {
  const t = useTranslations("agents.detail.activity.last30");
  const locale = useLocale();
  const r = row === null ? null : tokenRollup(row);
  const mine =
    findings !== null && findings.ok && agentKey !== null
      ? findings.value.findings.filter(
          (f) => f.level === "agent" && f.subject === agentKey,
        )
      : [];
  return (
    <Panel
      id="agent-activity-last30"
      title={t("title")}
      lead={t("lead")}
      aside={
        agentKey === null ? undefined : (
          <SafeLink
            to={routes.spend(place.org, place.ws, {
              tab: "agent",
              drill: agentKey,
            })}
            className={buttonSecondary}
          >
            {t("spend")}
          </SafeLink>
        )
      }
    >
      <Facts
        rows={[
          {
            term: t("runs"),
            value:
              row === null ? (
                <NotRecordedValue />
              ) : (
                formatCount(row.runs, locale)
              ),
          },
          {
            term: t("spendLabel"),
            value:
              row?.cost == null ? (
                <NotRecordedValue />
              ) : (
                <>
                  <Money value={row.cost} />
                  <Sub>
                    {t("basis")}{" "}
                    <span className={mono}>
                      {row.cost.basis ?? t("basisNone")}
                    </span>
                  </Sub>
                </>
              ),
          },
          {
            term: t("productive"),
            value:
              row?.productiveRatio == null ? (
                <NotRecordedValue />
              ) : (
                <>
                  {formatRatio(row.productiveRatio, locale)}
                  <Sub>{t("productiveSub")}</Sub>
                </>
              ),
          },
          {
            term: t("tokens"),
            value:
              r === null ? (
                <NotRecordedValue />
              ) : r.cacheRate === null ? (
                formatCount(r.total, locale)
              ) : (
                t("tokensValue", {
                  tokens: formatCount(r.total, locale),
                  rate: formatRatio(r.cacheRate, locale),
                })
              ),
          },
        ]}
      />
      {findings !== null && !findings.ok ? (
        <ReadFailure read={findings} section={t("findings")} />
      ) : mine.length === 0 ? (
        <Note>{t("noFinding")}</Note>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="agent-findings">
          {mine.map((finding) => (
            <li
              key={finding.id}
              className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
            >
              <p className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-sm">{t(`kinds.${finding.kind}`)}</b>
                <Badge tone="approval" dot={false}>
                  <Money value={finding.saving} /> {t("atStake")}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">{finding.why}</p>
              <span className="flex gap-2">
                <SafeLink
                  to={routes.spend(place.org, place.ws, {
                    tab: "findings",
                    finding: finding.id,
                  })}
                  className={buttonSecondary}
                >
                  {t("evidence")}
                </SafeLink>
                <SafeLink
                  to={routes.spend(place.org, place.ws, {
                    tab: "findings",
                    finding: finding.id,
                  })}
                  className={buttonSecondary}
                >
                  {t("fix")}
                </SafeLink>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const TAMPER: ReadonlySet<string> = new Set(TAMPER_INCIDENT_KINDS);

/**
 * A page of the incident list: the newest page at `rows`, or the page at
 * `cursor`. The default size is left off the address (#4693).
 */
function incidentsLink(place: Place, rows: number, cursor?: string): SafePath {
  return routes.agent(place.org, place.ws, place.agent, {
    tab: "activity",
    rows: rows === INCIDENT_PAGE ? undefined : String(rows),
    cursor,
  });
}

function Incidents({
  read,
  cursor,
  rows,
  place,
}: {
  read: Read<IncidentPage>;
  cursor: string | null;
  rows: number;
  place: Place;
}) {
  const t = useTranslations("agents.detail.incidents");
  const list = useTranslations("ui.list");
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
      <Panel
        id="agent-incidents"
        title={t("empty.title")}
        lead={t("empty.lead")}
        testId="incidents-empty"
        aside={<Badge tone="allowed">{t("empty.badge")}</Badge>}
      >
        <p className="text-sm">
          {t("empty.body", { kinds: TAMPER_INCIDENT_KINDS.join(", ") })}
        </p>
        <SafeLink
          to={routes.audit(place.org)}
          className={`${buttonSecondary} self-start`}
        >
          {t("empty.register")}
        </SafeLink>
      </Panel>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {page.incidents.map((incident, index) => (
        <Panel
          key={incident.id}
          id={`agent-incident-${String(index)}`}
          title={incident.kind}
          lead={
            <>
              <Instant at={incident.detectedAt} />
              {" · "}
              {t(`detectedBy.${incident.detectedBy}`)}
              {incident.sessionId === null ? null : (
                <>
                  {" · "}
                  <span className={mono}>{incident.sessionId}</span>
                </>
              )}
            </>
          }
          tone={
            incident.severity === "tamper"
              ? "critical"
              : incident.severity === "warning"
                ? "approval"
                : undefined
          }
          testId="incident-panel"
          aside={
            <>
              {TAMPER.has(incident.kind) ? (
                <Badge tone="critical" dot={false}>
                  {t("tamper")}
                </Badge>
              ) : null}
              <Badge
                tone={
                  incident.severity === "tamper"
                    ? "critical"
                    : incident.severity === "warning"
                      ? "approval"
                      : "quiet"
                }
                data-severity={incident.severity}
              >
                {t(`severity.${incident.severity}`)}
              </Badge>
              <Badge
                tone={incident.resolvedAt === null ? "critical" : "allowed"}
              >
                {incident.resolvedAt === null ? t("open") : t("resolved")}
              </Badge>
            </>
          }
        >
          <Facts
            rows={[
              { term: t("happened"), value: <NotRecordedValue /> },
              {
                term: t("stopped"),
                value: incident.resolutionNote ?? <NotRecordedValue />,
              },
              incident.resolvedAt === null
                ? { term: t("owner"), value: <NotRecordedValue /> }
                : {
                    term: t("closed"),
                    value: <Instant at={incident.resolvedAt} />,
                  },
              {
                term: t("incident"),
                value: <span className={mono}>{incident.id}</span>,
              },
            ]}
          />
          <SafeLink
            to={routes.audit(place.org)}
            className={`${buttonSecondary} self-start`}
          >
            {t("audit")}
          </SafeLink>
        </Panel>
      ))}
      {/* The cursor only walks forward, so the step back is the newest
          page. Both steps keep the size, and a new size starts over at the
          newest page (#4693). */}
      <LinkPager
        label={t("pager")}
        rowsLabel={list("rows")}
        previousLabel={t("first")}
        nextLabel={t("next")}
        perPage={rows}
        sizes={INCIDENT_ROWS.map((size) => ({
          size,
          first: incidentsLink(place, size),
        }))}
        previous={cursor === null ? null : incidentsLink(place, rows)}
        next={
          page.nextCursor === null
            ? null
            : incidentsLink(place, rows, page.nextCursor)
        }
        className="px-0"
      />
      <div className={`${panel} px-4 py-3.5`}>
        <Note>{t("note")}</Note>
      </div>
    </div>
  );
}

export function ActivitySection({
  runs,
  row,
  spend,
  findings,
  incidents,
  cursor,
  rows,
  agentKey,
  place,
}: {
  runs: Read<AgentRunRows>;
  row: AgentSpendRow | null;
  spend: Read<unknown> | null;
  findings: Read<SpendFindings> | null;
  incidents: Read<IncidentPage>;
  cursor: string | null;
  /** The incidents a page holds, one of `INCIDENT_ROWS`. */
  rows: number;
  agentKey: string | null;
  place: Place;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="agent-activity-tab">
      <Runs runs={runs} row={row} place={place} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Accounting row={row} spend={spend} />
        <Last30
          row={row}
          findings={findings}
          agentKey={agentKey}
          place={place}
        />
      </div>
      <Incidents read={incidents} cursor={cursor} rows={rows} place={place} />
    </div>
  );
}
