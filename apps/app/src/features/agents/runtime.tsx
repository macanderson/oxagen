// Runtime (spec pages/agent.md, Runtime): the host this agent runs on, what
// its tier delivers, and how to take it back off.
//
// The Host panel reads the enrollment `get_agent` returns for each host
// (`tacho.hosts`), so this tab and the tacho record cannot disagree. What the
// enrollment does not record says so: the hook binary, the MCP endpoint, the
// settings file and the last checkpoint are not on it. The tier is recorded
// per run, not per host (G6), so "Tier earned" and the ladder's marker read
// the newest run of this agent, and with no run they mark nothing.
//
// The Runtimes page is not built in this workspace yet, so Open the runtime
// and All runtimes say so. Unenroll is `revoke_host_enrollment`, and Show the
// CLI path mints the single-use token and prints the enroll command
// (`create_enrollment_token`); a retired identity is archived, so it is
// offered neither.
import { useLocale, useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import type { EnforcementTier, RunRow } from "@/data/contracts/runs";
import { routes, type SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { formatCount } from "@/ui/money-format";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { EnrollHost, RevokeHost } from "./enrollment-controls";
import { Facts, Instant, NotRecordedValue, Note, Panel, Sub } from "./parts";
import { StubAction } from "./stub-action";

type Host = AgentDetail["hosts"][number];

/** The four rungs, weakest first (ADR-095). */
const TIERS: readonly EnforcementTier[] = [
  "observe",
  "harness",
  "gateway",
  "contained",
];

function rank(tier: EnforcementTier): number {
  return TIERS.indexOf(tier);
}

function hooksKey(ok: boolean | null) {
  if (ok === null) return "unreported";
  return ok ? "ok" : "missing";
}

function HostPanel({
  host,
  detail,
  lastRun,
  index,
}: {
  host: Host;
  detail: AgentDetail;
  lastRun: RunRow | null;
  index: number;
}) {
  const t = useTranslations("agents.detail.runtime.host");
  const agents = useTranslations("agents");
  const locale = useLocale();
  const tier = lastRun?.enforcementTier ?? null;
  const live = host.revokedAt === null;
  return (
    <Panel
      id={`agent-host-${String(index)}`}
      title={t("title")}
      lead={t("lead")}
      testId="host-panel"
      aside={
        <>
          <Badge tone={live && host.hooksOk !== false ? "allowed" : "approval"}>
            <span className={mono}>{host.status}</span>
          </Badge>
          <StubAction
            label={t("open.label")}
            title={t("open.title")}
            body={t("open.body")}
            gap="runtimes_page"
            testId="open-runtime"
          />
        </>
      }
    >
      <Facts
        rows={[
          {
            term: t("runtime"),
            value: (
              <>
                <span className={mono}>{host.hostname}</span>
                <Sub>
                  {t("runtimeSub", {
                    platform: host.platform,
                    mode: host.mode,
                  })}
                </Sub>
              </>
            ),
          },
          {
            term: t("harness"),
            value: (
              <>
                {agents(`harness.${detail.identity.harness}`)}
                <Sub>{t("harnessSub")}</Sub>
              </>
            ),
          },
          {
            term: t("deviceKey"),
            value: (
              <>
                <span className={`${mono} break-all`}>
                  {host.deviceKeyFingerprint}
                </span>
                <Sub>{t("deviceKeySub")}</Sub>
              </>
            ),
          },
          {
            term: t("collector"),
            value: (
              <>
                {host.collectorVersion === null ? (
                  <NotRecordedValue />
                ) : (
                  <span className={mono}>{host.collectorVersion}</span>
                )}
                <Sub>
                  {host.lastSeenAt === null ? (
                    t("neverSeen")
                  ) : (
                    <>
                      {t("lastSeen")} <Instant at={host.lastSeenAt} />
                    </>
                  )}
                </Sub>
              </>
            ),
          },
          { term: t("hookBinary"), value: <NotRecordedValue /> },
          {
            term: t("hooks"),
            value: (
              <span data-hooks={hooksKey(host.hooksOk)}>
                {t(`hooksValue.${hooksKey(host.hooksOk)}`)}
              </span>
            ),
          },
          {
            term: t("proxy"),
            value:
              tier === null ? (
                <NotRecordedValue />
              ) : (
                <>
                  {t(rank(tier) >= 2 ? "proxyRouted" : "proxyNot")}
                  <Sub>
                    {t(rank(tier) >= 2 ? "proxyRoutedSub" : "proxyNotSub")}
                  </Sub>
                </>
              ),
          },
          { term: t("mcp"), value: <NotRecordedValue /> },
          {
            term: t("bundle"),
            value:
              host.bundleVersionServed === null ? (
                <NotRecordedValue />
              ) : (
                t("bundleValue", {
                  version: formatCount(host.bundleVersionServed, locale),
                })
              ),
          },
          { term: t("settings"), value: <NotRecordedValue /> },
          {
            term: t("tier"),
            value: (
              <>
                {tier === null ? (
                  <NotRecordedValue />
                ) : (
                  <EnforcementTierBadge tier={tier} />
                )}
                <Sub>{t("tierSub")}</Sub>
              </>
            ),
          },
          {
            term: t("firstFrame"),
            value:
              detail.identity.firstFrameAt === null ? (
                t("noFrame")
              ) : (
                <span className={mono}>
                  <Instant at={detail.identity.firstFrameAt} />
                </span>
              ),
          },
          { term: t("checkpoint"), value: <NotRecordedValue /> },
          {
            term: t("expires"),
            value:
              host.revokedAt !== null ? (
                <>
                  {t("revoked")} <Instant at={host.revokedAt} />
                </>
              ) : (
                <Instant at={host.expiresAt} />
              ),
          },
        ]}
      />
    </Panel>
  );
}

function TierDelivers({ tier }: { tier: EnforcementTier | null }) {
  const t = useTranslations("agents.detail.runtime.tier");
  const answer = (row: "model" | "mcp" | "native" | "budgets" | "steering") =>
    tier === null ? <NotRecordedValue /> : t(`rows.${row}.${tier}`);
  return (
    <Panel
      id="agent-tier"
      title={t("title")}
      lead={t("lead")}
      aside={
        <StubAction
          label={t("all.label")}
          title={t("all.title")}
          body={t("all.body")}
          gap="runtimes_page"
          testId="all-runtimes"
        />
      }
    >
      <ol
        aria-label={t("ladder")}
        className="grid grid-cols-2 overflow-hidden rounded-lg border border-border md:grid-cols-4"
        data-testid="tier-ladder"
      >
        {TIERS.map((rung) => (
          <li
            key={rung}
            data-rung={rung}
            aria-current={rung === tier ? "step" : undefined}
            className={`flex flex-col gap-1 border-border px-3 py-2.5 not-last:border-r ${rung === tier ? "border-t-2 border-t-success bg-hl" : ""}`}
          >
            <span className={`${mono} font-semibold`}>{rung}</span>
            {rung === tier ? (
              <Badge tone="allowed">{t("thisAgent")}</Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {t(`rungs.${rung}`)}
            </span>
          </li>
        ))}
      </ol>
      {tier === null ? (
        <p className="text-xs text-muted-foreground">{t("noRun")}</p>
      ) : null}
      <Facts
        rows={[
          { term: t("rows.model.label"), value: answer("model") },
          { term: t("rows.mcp.label"), value: answer("mcp") },
          { term: t("rows.native.label"), value: answer("native") },
          { term: t("rows.budgets.label"), value: answer("budgets") },
          { term: t("rows.steering.label"), value: answer("steering") },
          {
            term: t("rows.credentials"),
            value: <b className="text-success">{t("none")}</b>,
          },
        ]}
      />
      <Note>{t("note")}</Note>
    </Panel>
  );
}

function Rollback({
  hosts,
  org,
  ws,
  here,
  retired,
}: {
  hosts: readonly Host[];
  org: string;
  ws: string;
  here: SafePath;
  retired: boolean;
}) {
  const t = useTranslations("agents.detail.runtime.rollback");
  return (
    <Panel id="agent-rollback" title={t("title")} lead={t("lead")}>
      <pre
        data-testid="unenroll-command"
        className={`${mono} overflow-x-auto rounded-lg border border-border bg-code-bg px-3 py-2 text-[12px]`}
      >
        {t("command")}
      </pre>
      <Note>{t("note")}</Note>
      <div className="flex flex-wrap gap-2">
        <StubAction
          label={t("smoke.label")}
          title={t("smoke.title")}
          body={t("smoke.body")}
          gap="smoke_session"
          testId="smoke-session"
        />
        {retired
          ? null
          : hosts.map((host) => (
              <RevokeHost
                key={host.hostEnrollmentId}
                org={org}
                ws={ws}
                hostEnrollmentId={host.hostEnrollmentId}
                hostname={host.hostname}
                here={here}
              />
            ))}
      </div>
    </Panel>
  );
}

export function RuntimeSection({
  detail,
  lastRun,
  org,
  ws,
  here,
}: {
  detail: AgentDetail;
  lastRun: RunRow | null;
  org: string;
  ws: string;
  /** This tab, re-read after an unenroll. */
  here: SafePath;
}) {
  const t = useTranslations("agents.detail.runtime");
  const { identity } = detail;
  const retired = identity.status === "retired";
  const live = detail.hosts.filter((host) => host.revokedAt === null);
  if (live.length === 0) {
    return (
      <div className="flex flex-col gap-4" data-testid="agent-runtime-tab">
        <OutcomePanel
          tone="neutral"
          testId="runtime-empty"
          title={t("empty.title")}
          actions={
            retired ? undefined : (
              <>
                <SafeLink
                  to={routes.register(org, ws, "wrap", { agent: identity.id })}
                  className={buttonSecondary}
                >
                  {t("empty.wrap")}
                </SafeLink>
                <EnrollHost
                  org={org}
                  ws={ws}
                  agentId={identity.id}
                  agentName={identity.name}
                />
              </>
            )
          }
        >
          {t("empty.body")}
        </OutcomePanel>
        {detail.hosts.map((host, index) => (
          <HostPanel
            key={host.hostEnrollmentId}
            host={host}
            detail={detail}
            lastRun={lastRun}
            index={index}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="agent-runtime-tab">
      {live.map((host, index) => (
        <HostPanel
          key={host.hostEnrollmentId}
          host={host}
          detail={detail}
          lastRun={lastRun}
          index={index}
        />
      ))}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <TierDelivers tier={lastRun?.enforcementTier ?? null} />
        <Rollback
          hosts={live}
          org={org}
          ws={ws}
          here={here}
          retired={retired}
        />
      </div>
    </div>
  );
}
