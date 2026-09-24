// Identity (spec pages/agent.md, Identity): the principal, and the one
// property most of the threat model rests on. Roles moved to Permissions and
// tier delivery to Runtime, so this tab says who the agent is and what it
// holds, and nothing about what it may do.
//
// Four panels, in the design's order: Identity, Credentials, Run credential
// and Trust relationships. The facts are `get_agent`'s; a fact it does not
// record says "not recorded" (the purpose lock and the live run tokens are
// not on the contract), and a write it has no contract for (Change identity,
// Revoke credential) is a StubAction that says so. The cost center row stays:
// it is where `set_cost_center` is reachable (ADR-142), though the design does
// not draw it.
import { useLocale, useTranslations } from "next-intl";
import type { AgentDetail, IncidentPage } from "@/data/contracts/agents";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { parseTomlSubset, tomlGet } from "@/shared/toml-subset";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { HarnessLabel } from "@/ui/harness-icon";
import { SafeLink } from "@/ui/navigation";
import { tamperOf } from "./agent-reads";
import { ChargeAgent, type CostCenterTarget } from "./cost-center-controls";
import { CredentialStateWord } from "./credential-state";
import { StatusPill } from "./header";
import { Facts, Instant, NotRecordedValue, Panel, Sub } from "./parts";
import { StubAction } from "./stub-action";

type Place = { org: string; ws: string; agent: string };

/** The model tier the definition file names, or null when there is no file or no tier. */
function modelTierOf(detail: AgentDetail): string | null {
  const source = detail.definition?.source;
  if (source === undefined) return null;
  const parsed = parseTomlSubset(source);
  if (!parsed.ok) return null;
  const tier = tomlGet(parsed.doc, "model_tier");
  return typeof tier === "string" ? tier : null;
}

/** The credential that is not revoked, newest first; else the newest of any. */
function runCredentialOf(detail: AgentDetail) {
  const byNewest = [...detail.credentials].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return byNewest.find((c) => c.revokedAt === null) ?? byNewest[0] ?? null;
}

function IdentityFacts({
  detail,
  operatorName,
  wsSlug,
  charge,
}: {
  detail: AgentDetail;
  operatorName: string | null;
  wsSlug: string;
  charge: CostCenterTarget | null;
}) {
  const t = useTranslations("agents.detail.identity.facts");
  const agents = useTranslations("agents");
  const { identity } = detail;
  const tier = modelTierOf(detail);
  return (
    <Panel id="agent-identity" title={t("title")} lead={t("lead")}>
      <Facts
        rows={[
          {
            term: t("agentKey"),
            value:
              identity.agentKey === null ? (
                <NotRecordedValue />
              ) : (
                <span className={mono}>{identity.agentKey}</span>
              ),
          },
          {
            term: t("principal"),
            value: (
              <>
                {identity.principalId === null ? (
                  <NotRecordedValue />
                ) : (
                  <span className={mono}>{identity.principalId}</span>
                )}
                <Sub>{t("principalSub")}</Sub>
              </>
            ),
          },
          {
            term: t("kind"),
            value: t("kindValue", { workspace: wsSlug }),
          },
          {
            term: t("harness"),
            value: (
              <HarnessLabel harness={identity.harness} size={16}>
                {agents(`harness.${identity.harness}`)}
              </HarnessLabel>
            ),
          },
          {
            term: t("modelTier"),
            value: (
              <>
                {tier === null ? (
                  <NotRecordedValue />
                ) : (
                  <span className={mono}>{tier}</span>
                )}
                <Sub>{t("modelTierSub")}</Sub>
              </>
            ),
          },
          {
            term: t("operator"),
            value: (
              <>
                {operatorName ??
                  (identity.operatorId === null ? (
                    <NotRecordedValue />
                  ) : (
                    <span className={mono}>{identity.operatorId}</span>
                  ))}
                <Sub>{t("operatorSub")}</Sub>
              </>
            ),
          },
          {
            term: t("lifecycle"),
            value: (
              <>
                <StatusPill status={identity.status} />
                <Sub>{t("lifecycleSub")}</Sub>
              </>
            ),
          },
          {
            term: t("firstFrame"),
            value:
              identity.firstFrameAt === null ? (
                t("noFrame")
              ) : (
                <span className={mono}>
                  <Instant at={identity.firstFrameAt} />
                </span>
              ),
          },
          {
            term: t("costCenter"),
            value: (
              <span
                data-cost-center={identity.costCenter ?? ""}
                className="flex flex-wrap items-center gap-2"
              >
                {identity.costCenter === null ? (
                  <span className="text-muted-foreground">
                    {t("inherited")}
                  </span>
                ) : (
                  <span className={mono}>{identity.costCenter}</span>
                )}
                {charge === null ? null : <ChargeAgent {...charge} />}
              </span>
            ),
          },
        ]}
      />
    </Panel>
  );
}

const PROVIDER_CREDENTIALS = [
  "apiKey",
  "oauthToken",
  "cloudRole",
  "githubToken",
] as const;

function Credentials({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("agents.detail.identity.credentials");
  const pair =
    "flex flex-col rounded-lg border border-border bg-hl px-3 py-2 text-[13px]";
  return (
    <Panel
      id="agent-credentials"
      title={t("title")}
      lead={t("lead")}
      tone="proven"
      aside={<Badge tone="proven">{t("none")}</Badge>}
    >
      <ul className="flex flex-wrap gap-2" data-testid="credential-pairs">
        {PROVIDER_CREDENTIALS.map((key) => (
          <li key={key} className={pair}>
            <span>{t(key)}</span>
            <span className="text-xs text-dim">{t("none")}</span>
          </li>
        ))}
        <li className={pair}>
          <span>{t("runToken")}</span>
          <span className="text-xs text-dim">{t("runTokenValue")}</span>
        </li>
      </ul>
      <p className="text-[13px]">{t("body")}</p>
      <SafeLink
        to={routes.tools(org, ws, { tab: "providers" })}
        className={`${buttonSecondary} self-start`}
      >
        {t("connections")}
      </SafeLink>
    </Panel>
  );
}

function RunCredential({
  detail,
  now,
  operatorName,
}: {
  detail: AgentDetail;
  now: number;
  operatorName: string | null;
}) {
  const t = useTranslations("agents.detail.identity.runCredential");
  const credential = runCredentialOf(detail);
  const host = detail.hosts.find((h) => h.revokedAt === null) ?? null;
  return (
    <Panel id="agent-run-credential" title={t("title")} lead={t("lead")}>
      {credential === null ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Facts
          rows={[
            {
              term: t("key"),
              value: (
                <>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={mono}>{`${credential.prefix}…`}</span>
                    <CredentialStateWord credential={credential} now={now} />
                  </span>
                  <Sub>{t("keySub")}</Sub>
                </>
              ),
            },
            {
              term: t("purposeLock"),
              value: <NotRecordedValue />,
            },
            {
              term: t("issued"),
              value: (
                <>
                  <Instant at={credential.createdAt} />
                  {operatorName === null ? null : (
                    <> {t("issuedTo", { name: operatorName })}</>
                  )}
                </>
              ),
            },
            {
              term: t("lastUsed"),
              value:
                credential.lastUsedAt === null ? (
                  t("never")
                ) : (
                  <span className={mono}>
                    <Instant at={credential.lastUsedAt} />
                  </span>
                ),
            },
            {
              term: t("expires"),
              value:
                credential.expiresAt === null ? (
                  t("noExpiry")
                ) : (
                  <Instant at={credential.expiresAt} />
                ),
            },
            {
              term: t("runTokens"),
              value: (
                <>
                  <NotRecordedValue />
                  <Sub>{t("runTokensSub")}</Sub>
                </>
              ),
            },
            {
              term: t("deviceKey"),
              value:
                host === null ? (
                  <span className="text-muted-foreground">
                    {t("notEnrolled")}
                  </span>
                ) : (
                  <>
                    <span className={`${mono} break-all`}>
                      {host.deviceKeyFingerprint}
                    </span>
                    <Sub>{t("deviceKeySub", { host: host.hostname })}</Sub>
                  </>
                ),
            },
          ]}
        />
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <StubAction
          label={t("change.open")}
          title={t("change.title")}
          body={t("change.body")}
          gap="agent_operator_change"
          testId="change-identity"
        />
        <StubAction
          label={t("revoke.open")}
          title={t("revoke.title")}
          body={t("revoke.body")}
          gap="agent_credential_revoke"
          testId="revoke-credential"
          danger
        />
      </div>
    </Panel>
  );
}

function TrustRelationships({
  detail,
  lastRun,
  operatorName,
  incidents,
  wsName,
  wsSlug,
  place,
}: {
  detail: AgentDetail;
  lastRun: RunRow | null;
  operatorName: string | null;
  incidents: Read<IncidentPage>;
  wsName: string;
  wsSlug: string;
  place: Place;
}) {
  const t = useTranslations("agents.detail.identity.trust");
  const locale = useLocale();
  const { identity } = detail;
  const host = detail.hosts.find((h) => h.revokedAt === null) ?? null;
  const list = tamperOf(incidents);
  return (
    <Panel id="agent-trust" title={t("title")} lead={t("lead")}>
      <Facts
        rows={[
          {
            term: t("human"),
            value: (
              <>
                {operatorName ??
                  (identity.operatorId === null ? (
                    <NotRecordedValue />
                  ) : (
                    <span className={mono}>{identity.operatorId}</span>
                  ))}
                <Sub>{t("humanSub")}</Sub>
              </>
            ),
          },
          {
            term: t("workspace"),
            value: (
              <>
                {wsName} <span className={`${mono} text-dim`}>{wsSlug}</span>
                <Sub>{t("workspaceSub")}</Sub>
              </>
            ),
          },
          {
            term: t("runtime"),
            value: (
              <>
                {host === null ? (
                  <span className="text-muted-foreground">
                    {t("notEnrolled")}
                  </span>
                ) : (
                  <span className={mono}>{host.hostname}</span>
                )}
                <Sub>
                  {host === null ? t("runtimeNoneSub") : t("runtimeSub")}
                </Sub>
              </>
            ),
          },
          {
            term: t("delegation"),
            value: (
              <>
                {t("delegationValue")}
                <Sub>{t("delegationSub")}</Sub>
              </>
            ),
          },
          {
            term: t("replay"),
            value: (
              <>
                {lastRun?.replayGrade == null ? (
                  <NotRecordedValue />
                ) : (
                  <span className={mono}>{lastRun.replayGrade}</span>
                )}
                <Sub>{t("replaySub")}</Sub>
              </>
            ),
          },
          {
            term: t("tamper"),
            value:
              list === null ? (
                <NotRecordedValue />
              ) : list.length === 0 ? (
                <Badge tone="allowed">{formatCount(0, locale)}</Badge>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="critical">
                    {t("tamperValue", {
                      count: formatCount(list.length, locale),
                      kind: list[0]?.kind ?? "",
                    })}
                  </Badge>
                  <SafeLink
                    to={routes.agent(place.org, place.ws, place.agent, {
                      tab: "activity",
                    })}
                    className={buttonSecondary}
                  >
                    {t("readThem")}
                  </SafeLink>
                </span>
              ),
          },
        ]}
      />
      <SafeLink
        to={routes.agent(place.org, place.ws, place.agent, {
          tab: "permissions",
        })}
        className={`${buttonSecondary} self-start`}
      >
        {t("permissions")}
      </SafeLink>
    </Panel>
  );
}

export function IdentitySection({
  detail,
  now,
  lastRun,
  operatorName,
  incidents,
  wsName,
  wsSlug,
  place,
  charge,
}: {
  detail: AgentDetail;
  /** The instant the agent was read; a credential's expiry is judged against it. */
  now: number;
  lastRun: RunRow | null;
  operatorName: string | null;
  incidents: Read<IncidentPage>;
  wsName: string;
  wsSlug: string;
  place: Place;
  /**
   * Where the cost-center write goes, or null when this viewer may not make
   * one (ADR-142): an org Owner, Admin or Billing member, on a live identity.
   */
  charge: CostCenterTarget | null;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="agent-identity-tab">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <IdentityFacts
          detail={detail}
          operatorName={operatorName}
          wsSlug={wsSlug}
          charge={charge}
        />
        <Credentials org={place.org} ws={place.ws} />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <RunCredential detail={detail} now={now} operatorName={operatorName} />
        <TrustRelationships
          detail={detail}
          lastRun={lastRun}
          operatorName={operatorName}
          incidents={incidents}
          wsName={wsName}
          wsSlug={wsSlug}
          place={place}
        />
      </div>
    </div>
  );
}
