// The agent page's header (spec pages/agent.md, Header): the eyebrow, the
// agent card as the h1, four badges and the description, then the writes.
//
// **Every badge is a recorded word and nothing stronger.** The status is the
// identity's own. The enforcement tier and the replay grade are recorded per
// run, not per agent (G6 computes an agent's tier; nothing stores one), so the
// two badges print the words the newest run of this agent recorded and say
// which run in their title. With no run on the page they say "not recorded"
// rather than guessing. The operator is named from that same run when the run
// was made on behalf of the agent's operator: `get_agent` carries the
// operator's id and not a name, and an id is a key, not a label.
//
// No action here is gold. The one gold action of the workspace is Wrap Claude
// Code on the Agents page. Clone and Kill switch are not in the design; they
// stay because they are the only place either write is reachable from.
import { useTranslations } from "next-intl";
import type { AgentDetail, AgentStatus } from "@/data/contracts/agents";
import type { RunRow } from "@/data/contracts/runs";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { Badge, type BadgeTone } from "@/ui/badge";
import { CloneButton } from "@/ui/clone-button";
import { eyebrow } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { HarnessIcon } from "@/ui/harness-icon";
import { AgentActions } from "./agent-actions";
import { AgentKillSwitch } from "./kill-switch";
import { StubAction } from "./stub-action";

const STATUS_TONE: Record<AgentStatus, BadgeTone> = {
  enrolled: "allowed",
  unenrolled: "quiet",
  suspended: "denied",
  retired: "quiet",
};

/** The identity's state as a dot and a word in the state pill. */
export function StatusPill({ status }: { status: AgentStatus }) {
  const t = useTranslations("agents.status");
  return (
    <Badge tone={STATUS_TONE[status]} data-status={status}>
      {t(status)}
    </Badge>
  );
}

/** The operator's name, when the newest run names the agent's own operator. */
export function operatorNameOf(
  identity: AgentDetail["identity"],
  lastRun: RunRow | null,
): string | null {
  if (lastRun === null || identity.operatorId === null) return null;
  return lastRun.operatorId === identity.operatorId
    ? lastRun.operatorName
    : null;
}

export function AgentHeader({
  identity,
  lastRun,
  orgRole,
  org,
  ws,
}: {
  identity: AgentDetail["identity"];
  /** The newest run of this agent on the page of runs read, or null. */
  lastRun: RunRow | null;
  orgRole: WsCtx["orgRole"];
  org: string;
  ws: string;
}) {
  const t = useTranslations("agents.detail.header");
  const agents = useTranslations("agents");
  const operator = operatorNameOf(identity, lastRun);
  const live = identity.status !== "retired";
  return (
    <header
      aria-label={t("label")}
      data-testid="agent-header"
      className="flex flex-col gap-3 pb-1 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <p className={eyebrow}>{t("eyebrow")}</p>
        <h1 className="min-w-0 text-foreground">
          <AgentCard
            layout="detail"
            agentKey={identity.agentKey}
            notRecorded={agents("notRecorded")}
            sub={
              <span className="inline-flex items-center gap-1.5 font-mono">
                <HarnessIcon harness={identity.harness} size={14} />
                {agents(`harness.${identity.harness}`)}
              </span>
            }
          />
        </h1>
        <p
          data-testid="agent-badges"
          className="flex flex-wrap items-center gap-2"
        >
          <StatusPill status={identity.status} />
          {identity.managed ? (
            <span title={t("managedTitle")}>
              <Badge tone="quiet" dot={false} data-managed="true">
                {t("managed")}
              </Badge>
            </span>
          ) : null}
          {lastRun === null ? (
            <Badge tone="quiet" dot={false} mono data-tier="">
              {t("tierNotRecorded")}
            </Badge>
          ) : (
            <span title={t("fromRun", { run: lastRun.id })}>
              <EnforcementTierBadge tier={lastRun.enforcementTier} />
            </span>
          )}
          <Badge
            tone="quiet"
            dot={false}
            data-replay={lastRun?.replayGrade ?? ""}
          >
            {lastRun?.replayGrade == null
              ? t("replayNotRecorded")
              : t("replay", { grade: lastRun.replayGrade })}
          </Badge>
          <Badge
            tone="quiet"
            dot={false}
            data-operator={identity.operatorId ?? ""}
          >
            {operator === null
              ? t("operatorNotRecorded")
              : t("operator", { name: operator })}
          </Badge>
        </p>
        {identity.description === null ? null : (
          <p className="max-w-prose text-[13px] text-muted-foreground">
            {identity.description}
          </p>
        )}
      </div>
      <div
        data-testid="agent-header-actions"
        className="flex flex-wrap items-start gap-2 sm:justify-end"
      >
        <StubAction
          label={t("avatar.open")}
          title={t("avatar.title")}
          body={t("avatar.body")}
          gap="agent_avatar"
          testId="edit-avatar"
        />
        {/* The built-in assistant takes no identity write (#4350). */}
        {live && !identity.managed ? (
          <AgentActions
            org={org}
            ws={ws}
            agentId={identity.id}
            name={identity.name}
            slug={identity.slug}
            suspended={identity.status === "suspended"}
            here={routes.agent(org, ws, identity.slug)}
            list={routes.agents(org, ws)}
          />
        ) : null}
        <CloneButton kind="agent" sourceRef={identity.id} />
        {live ? (
          <AgentKillSwitch
            org={org}
            ws={ws}
            agentId={identity.id}
            agentKey={identity.agentKey}
            name={identity.name}
            orgRole={orgRole}
          />
        ) : null}
      </div>
    </header>
  );
}
