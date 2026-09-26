// Overview (spec pages/agent.md, Overview): what this agent is made of, and
// the first question the page answers. The panels, in the design's order: the
// 30-day token use beside the coaching, then the composition beside the last
// 30 days, then the agent's versions (ADR-192), which took the place of the
// definition in git. The composition names the toolbelt the agent carries and
// the runtime it runs on.
//
// Every figure is this agent's own row of the 30-day rollup (`tokens.ts`).
// The design's eight token classes split input six ways and nothing records
// that split yet (G3), so the six input classes say so and the two classes
// the rollup does record, output and reasoning, carry their figures. Coaching
// is derived from that split, so it waits on the same gap and says so rather
// than claiming there is nothing to change.
import { useLocale, useTranslations } from "next-intl";
import type {
  AgentDetail,
  IncidentPage,
  Toolbelt,
} from "@/data/contracts/agents";
import type { MandateList } from "@/data/contracts/mandates";
import { divMicros } from "@/data/contracts/money";
import type { RunRow } from "@/data/contracts/runs";
import type { SteeringDeliveries } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { tamperOf } from "./agent-reads";
import { Badge, type BadgeTone } from "@/ui/badge";
import { buttonSecondary, linkText, mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { Money } from "@/ui/money";
import { formatCount, formatRatio, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import {
  Facts,
  Instant,
  NotBacked,
  NotRecordedValue,
  Note,
  Panel,
  Sub,
  Tile,
} from "./parts";
import {
  type AgentSpendRow,
  TOKEN_CLASSES,
  type TokenRollup,
  tokenRollup,
} from "./tokens";
import { AgentVersions } from "./versions";

type Place = { org: string; ws: string; agent: string };

/** The health verdict the Composition panel is badged with, from what the record holds. */
export type Health = {
  tone: BadgeTone;
  word: "tamper" | "notEnrolled" | "observe" | "healthy" | "noFrame";
  openIncidents: number;
};

function healthOf(
  detail: AgentDetail,
  incidents: Read<IncidentPage>,
  lastRun: RunRow | null,
): Health {
  const open = (tamperOf(incidents) ?? []).filter(
    (i) => i.resolvedAt === null,
  ).length;
  if (open > 0)
    return { tone: "critical", word: "tamper", openIncidents: open };
  if (detail.hosts.length === 0 && detail.identity.status !== "enrolled")
    return { tone: "quiet", word: "notEnrolled", openIncidents: 0 };
  if (lastRun === null)
    return { tone: "quiet", word: "noFrame", openIncidents: 0 };
  if (lastRun.enforcementTier === "observe")
    return { tone: "approval", word: "observe", openIncidents: 0 };
  return { tone: "allowed", word: "healthy", openIncidents: 0 };
}

/** The basis word under a spend figure, or null when nobody recorded who observed it. */
function BasisWord({ basis }: { basis: string | null }) {
  const t = useTranslations("agents.detail.overview");
  if (basis === null) return <>{t("basisNotRecorded")}</>;
  return <span className={mono}>{basis}</span>;
}

function TokenUse({
  row,
  spend,
}: {
  row: AgentSpendRow | null;
  spend: Read<unknown> | null;
}) {
  const t = useTranslations("agents.detail.overview.tokens");
  const locale = useLocale();
  const n = (value: number) => formatCount(value, locale);
  if (spend !== null && !spend.ok) {
    return (
      <Panel id="agent-token-use" title={t("title")}>
        <ReadFailure read={spend} section={t("title")} />
      </Panel>
    );
  }
  if (row === null) {
    return (
      <Panel id="agent-token-use" title={t("title")}>
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      </Panel>
    );
  }
  const r: TokenRollup = tokenRollup(row);
  return (
    <Panel
      id="agent-token-use"
      title={t("title")}
      aside={
        <span
          data-testid="token-badge"
          className={`${mono} text-[11px] text-muted-foreground`}
        >
          {t("badge", { tokens: n(r.total) })}
          {" · "}
          {row.cost === null ? (
            t("costNotRecorded")
          ) : (
            <Money value={row.cost} />
          )}
          {" · "}
          <BasisWord basis={row.cost?.basis ?? null} />
        </span>
      }
    >
      <ul className="flex flex-col gap-2.5" data-testid="token-classes">
        {TOKEN_CLASSES.map((c) => {
          const value = c.recorded === null ? null : r[c.recorded];
          return (
            <li key={c.key} data-class={c.key} className="flex flex-col gap-1">
              <span className="flex items-baseline justify-between gap-3 text-[13px]">
                <span>{t(`classes.${c.key}`)}</span>
                {value === null ? (
                  <NotRecordedValue />
                ) : (
                  <span className={`${mono} font-semibold`}>
                    {n(value)}
                    <span className="font-normal text-dim">
                      {" · "}
                      {r.total === 0
                        ? "0%"
                        : formatRatio(value / r.total, locale)}
                    </span>
                  </span>
                )}
              </span>
              <span
                aria-hidden="true"
                className="block h-1.5 overflow-hidden rounded-full bg-hl"
              >
                {value === null || r.total === 0 ? null : (
                  <span
                    className="block h-full rounded-full bg-foreground/70"
                    style={{ width: ratioWidth(value / r.total) }}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <NotBacked gap="G3">{t("inputSplit", { input: n(r.input) })}</NotBacked>
      <Facts
        rows={[
          {
            term: t("cacheRate"),
            value:
              r.cacheRate === null ? (
                <NotRecordedValue />
              ) : (
                t("cacheRateValue", {
                  rate: formatRatio(r.cacheRate, locale),
                  read: n(r.cacheRead),
                  input: n(r.input),
                })
              ),
          },
          {
            term: t("perRun"),
            value:
              r.perRun === null ? (
                <NotRecordedValue />
              ) : (
                <>
                  {t("tok", { tokens: n(r.perRun) })}
                  {" · "}
                  {row.cost === null ? (
                    t("costNotRecorded")
                  ) : (
                    <PerRunCost cost={row.cost} runs={row.runs} />
                  )}
                </>
              ),
          },
          {
            term: t("perCall"),
            value:
              r.perCall === null ? (
                <NotRecordedValue />
              ) : (
                t("perCallValue", { tokens: n(r.perCall) })
              ),
          },
          {
            term: t("basis"),
            value: t(`basisValue.${row.cost?.basis ?? "none"}`),
          },
        ]}
      />
    </Panel>
  );
}

function PerRunCost({
  cost,
  runs,
}: {
  cost: NonNullable<AgentSpendRow["cost"]>;
  runs: number;
}) {
  const value = divMicros(cost, runs);
  return value === null ? <NotRecordedValue /> : <Money value={value} />;
}

function Coaching({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("agents.detail.overview.coaching");
  return (
    <Panel
      id="agent-coaching"
      title={t("title")}
      aside={
        <Badge tone="quiet" dot={false}>
          {t("badge")}
        </Badge>
      }
    >
      <NotBacked gap="G3">{t("notBacked")}</NotBacked>
      <div className="-mx-4 -mb-4 border-t border-border px-4 py-3">
        <SafeLink
          to={routes.spend(org, ws, { tab: "findings" })}
          className={`${linkText} text-sm`}
        >
          {t("all")}
        </SafeLink>
      </div>
    </Panel>
  );
}

function OpenButton({
  to,
  label,
}: {
  to: ReturnType<typeof routes.agent>;
  label: string;
}) {
  return (
    <SafeLink to={to} className={`${buttonSecondary} mt-1.5 self-start`}>
      {label}
    </SafeLink>
  );
}

function Composition({
  detail,
  toolbelt,
  mandates,
  deliveries,
  health,
  lastRun,
  operatorName,
  place,
}: {
  detail: AgentDetail;
  toolbelt: Read<Toolbelt>;
  mandates: Read<MandateList>;
  deliveries: Read<SteeringDeliveries> | null;
  health: Health;
  lastRun: RunRow | null;
  operatorName: string | null;
  place: Place;
}) {
  const t = useTranslations("agents.detail.overview.composition");
  const locale = useLocale();
  const n = (value: number) => formatCount(value, locale);
  const { identity } = detail;
  const open = t("open");
  const tab = (name: string) =>
    routes.agent(place.org, place.ws, place.agent, { tab: name });
  const manifest =
    deliveries !== null && deliveries.ok && identity.agentKey !== null
      ? (deliveries.value.runs.find(
          (run) => run.agentKey === identity.agentKey,
        ) ?? null)
      : null;
  const host = detail.hosts[0] ?? null;
  const held = mandates.ok ? mandates.value.mandates.length : null;
  return (
    <Panel
      id="agent-composition"
      title={t("title")}
      lead={t("lead")}
      aside={
        <Badge tone={health.tone} data-health={health.word}>
          {t(`health.${health.word}`)}
        </Badge>
      }
    >
      <Facts
        rows={[
          {
            term: t("identity"),
            value: (
              <span className="flex flex-col">
                {identity.principalId === null ? (
                  <NotRecordedValue />
                ) : (
                  <span className={mono}>{identity.principalId}</span>
                )}
                <Sub>{t("identitySub")}</Sub>
                <OpenButton to={tab("identity")} label={open} />
              </span>
            ),
          },
          {
            term: t("steering"),
            value: (
              <span className="flex flex-col">
                {manifest === null ? (
                  <span className="text-muted-foreground">
                    {t("steeringNone")}
                  </span>
                ) : (
                  <span>
                    {t("steeringItems", {
                      items: n(manifest.recordsIncluded),
                      tokens: n(manifest.spentTokens),
                    })}
                  </span>
                )}
                <Sub>
                  {manifest === null ? t("steeringNoneSub") : t("steeringSub")}
                </Sub>
                <OpenButton to={tab("steering")} label={open} />
              </span>
            ),
          },
          {
            term: t("toolbelt"),
            value: (
              <span className="flex flex-col gap-1">
                {detail.toolbelt === null ? (
                  <NotRecordedValue />
                ) : (
                  <span data-testid="composition-belt">
                    {detail.toolbelt.name}
                  </span>
                )}
                <Sub>
                  {toolbelt.ok
                    ? t("toolbeltSub", {
                        count: toolbelt.value.tools.length,
                        mode: toolbelt.value.presentation.mode,
                      })
                    : t("toolbeltUnread")}
                </Sub>
                <OpenButton to={tab("toolbelt")} label={open} />
              </span>
            ),
          },
          {
            term: t("runtime"),
            value: (
              <span className="flex flex-col">
                {detail.runtime === null ? null : (
                  <span data-testid="composition-runtime">
                    {detail.runtime.name}
                  </span>
                )}
                {host === null ? (
                  <span className="text-muted-foreground">
                    {t("runtimeNone")}
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={mono}>{host.hostname}</span>
                    {lastRun === null ? null : (
                      <EnforcementTierBadge tier={lastRun.enforcementTier} />
                    )}
                  </span>
                )}
                {host === null ? null : (
                  <Sub>
                    {t("runtimeSub", {
                      platform: host.platform,
                      mode: host.mode,
                    })}
                  </Sub>
                )}
                <OpenButton to={tab("runtime")} label={open} />
              </span>
            ),
          },
          {
            term: t("owner"),
            value: (
              <span className="flex flex-col">
                {operatorName === null ? (
                  identity.operatorId === null ? (
                    <NotRecordedValue />
                  ) : (
                    <span className={mono}>{identity.operatorId}</span>
                  )
                ) : (
                  <span>{operatorName}</span>
                )}
                <Sub>{t("ownerSub")}</Sub>
              </span>
            ),
          },
          {
            term: t("permissions"),
            value: (
              <span className="flex flex-col">
                <span>
                  {t("roles", { count: detail.roles.length })}
                  {" · "}
                  {held === null
                    ? t("mandatesUnread")
                    : t("mandates", { count: held })}
                </span>
                <Sub>{t("permissionsSub")}</Sub>
                <OpenButton to={tab("permissions")} label={open} />
              </span>
            ),
          },
        ]}
      />
    </Panel>
  );
}

function Last30({
  row,
  lastRun,
  incidents,
  health,
  place,
}: {
  row: AgentSpendRow | null;
  lastRun: RunRow | null;
  incidents: Read<IncidentPage>;
  health: Health;
  place: Place;
}) {
  const t = useTranslations("agents.detail.overview.last30");
  const locale = useLocale();
  const r = row === null ? null : tokenRollup(row);
  const tamper = tamperOf(incidents)?.length ?? null;
  return (
    <Panel
      id="agent-last30"
      title={t("title")}
      lead={t("lead")}
      aside={
        <SafeLink
          to={routes.agent(place.org, place.ws, place.agent, {
            tab: "activity",
          })}
          className={buttonSecondary}
        >
          {t("open")}
        </SafeLink>
      }
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Tile
          title={t("runs")}
          value={
            row === null ? <NotRecordedValue /> : formatCount(row.runs, locale)
          }
          basis={
            lastRun === null ? (
              t("runsNone")
            ) : (
              <>
                {t("lastAt")} <Instant at={lastRun.startedAt} />
              </>
            )
          }
        />
        <Tile
          title={t("spend")}
          value={
            row?.cost == null ? (
              <NotRecordedValue />
            ) : (
              <Money value={row.cost} />
            )
          }
          basis={<BasisWord basis={row?.cost?.basis ?? null} />}
        />
        <Tile
          title={t("tokens")}
          value={
            r === null ? <NotRecordedValue /> : formatCount(r.total, locale)
          }
          basis={
            r?.cacheRate == null
              ? t("cacheNotRecorded")
              : t("cacheRate", { rate: formatRatio(r.cacheRate, locale) })
          }
        />
        <Tile
          title={t("tamper")}
          value={
            tamper === null ? <NotRecordedValue /> : formatCount(tamper, locale)
          }
          basis={t(`health.${health.word}`, { count: health.openIncidents })}
        />
      </div>
      <Note>{t("note")}</Note>
    </Panel>
  );
}

export function Overview({
  detail,
  toolbelt,
  mandates,
  incidents,
  deliveries,
  spend,
  spendRow,
  lastRun,
  operatorName,
  place,
}: {
  detail: AgentDetail;
  toolbelt: Read<Toolbelt>;
  mandates: Read<MandateList>;
  incidents: Read<IncidentPage>;
  deliveries: Read<SteeringDeliveries> | null;
  spend: Read<unknown> | null;
  spendRow: AgentSpendRow | null;
  lastRun: RunRow | null;
  operatorName: string | null;
  place: Place;
}) {
  const health = healthOf(detail, incidents, lastRun);
  return (
    <div className="flex flex-col gap-4" data-testid="agent-overview">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <TokenUse row={spendRow} spend={spend} />
        <Coaching org={place.org} ws={place.ws} />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Composition
          detail={detail}
          toolbelt={toolbelt}
          mandates={mandates}
          deliveries={deliveries}
          health={health}
          lastRun={lastRun}
          operatorName={operatorName}
          place={place}
        />
        <Last30
          row={spendRow}
          lastRun={lastRun}
          incidents={incidents}
          health={health}
          place={place}
        />
      </div>
      <AgentVersions versions={detail.versions} />
    </div>
  );
}
