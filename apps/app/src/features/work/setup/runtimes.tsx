// Work setup › Runtimes (roadmap mockups/src/work-setup.js `runtimesTab()`;
// mockups/pages/work-setup.md): one row per agent, read with
// list_work_targets the way send_work_order reads its target (ADR-251). Each
// row names the agent, its runtime and the host's last poll, the tier the
// send would record, whether it can take a send now and why not, and where
// its budget holds. The tab is read-only: enrollment and tiers live on Agents.
//
// Every budget sentence names where the budget holds. On a gateway or
// contained runtime the gateway holds it before each model call. On a
// harness or observe runtime oxagen only records spend after the run. A host
// that has not polled in five minutes can still take a send, which waits
// until it polls, so the row says so and blocks nothing.
import { useTranslations } from "next-intl";
import type { WorkTarget, WorkTargetList } from "@/data/contracts/work";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { HarnessIcon } from "@/ui/harness-icon";
import { SafeLink } from "@/ui/navigation";
import { StateWrap } from "@/ui/state-wrap";
import { cell, Table } from "@/ui/table";
import { WorkReadFailure } from "../read-failure";

function Sub({ children }: { children: string }) {
  return (
    <span className="block text-sm text-muted-foreground">{children}</span>
  );
}

/** Why the agent cannot take a send now, in one sentence. */
function useRefusal(): (target: WorkTarget) => string | null {
  const t = useTranslations("work.setup.runtimes.reason");
  return (target) => {
    switch (target.reason) {
      case null:
        return null;
      case "no_runtime":
        return t("no_runtime");
      case "no_host":
        return t("no_host");
      case "host_outdated":
        return t("host_outdated");
      case "not_operator":
        return t("not_operator");
      case "busy":
        return target.busyWith === null
          ? null
          : t("busy", { number: target.busyWith.number });
    }
  };
}

function TargetRow({ target }: { target: WorkTarget }) {
  const t = useTranslations("work.setup.runtimes");
  const format = useFormatter();
  const refusal = useRefusal()(target);
  const when = (at: string) =>
    format.dateTime(new Date(at), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const tier = target.runtime?.tier ?? null;
  const lastPoll = target.host?.lastPollAt ?? null;
  return (
    <tr
      data-agent={target.id}
      data-can-take={String(target.canTake)}
      data-reason={target.reason ?? ""}
    >
      <td className={cell}>
        <span className="font-medium">{target.name}</span>
        <span
          className={`${mono} flex items-center gap-1.5 text-sm text-muted-foreground`}
        >
          <HarnessIcon harness={target.harness} size={14} />
          {target.harness}
        </span>
      </td>
      <td className={cell}>
        {target.runtime === null ? (
          <span className="text-muted-foreground">{t("none")}</span>
        ) : (
          <>
            <span>{target.runtime.name}</span>
            {target.host === null ? null : (
              <Sub>
                {lastPoll === null
                  ? t("neverPolled")
                  : t("lastPoll", { at: when(lastPoll) })}
              </Sub>
            )}
          </>
        )}
      </td>
      <td className={cell}>
        {tier === null ? (
          <span className="text-muted-foreground">{t("none")}</span>
        ) : (
          <EnforcementTierBadge tier={tier} />
        )}
      </td>
      <td className={cell}>
        <span className="flex flex-col items-start gap-1">
          {target.canTake ? (
            <Badge tone="allowed" data-send="ready">
              {t("ready")}
            </Badge>
          ) : target.reason === "busy" ? (
            <Badge tone="approval" data-send="busy">
              {t("busy")}
            </Badge>
          ) : (
            <Badge tone="quiet" data-send="blocked">
              {t("blocked")}
            </Badge>
          )}
          {refusal === null ? null : <Sub>{refusal}</Sub>}
          {target.quiet ? (
            <Sub>
              {lastPoll === null
                ? t("quietNever")
                : t("quiet", { at: when(lastPoll) })}
            </Sub>
          ) : null}
        </span>
      </td>
      <td className={`${cell} text-sm`} data-budget={tier ?? "none"}>
        {tier === null ? (
          <span className="text-muted-foreground">{t("none")}</span>
        ) : tier === "gateway" || tier === "contained" ? (
          t("budgetGateway", { agent: target.name })
        ) : (
          t("budgetRecorded")
        )}
      </td>
    </tr>
  );
}

export function RuntimesTab({
  org,
  ws,
  read,
}: {
  org: string;
  ws: string;
  read: Read<WorkTargetList>;
}) {
  const t = useTranslations("work.setup");
  if (!read.ok)
    return (
      <WorkReadFailure
        read={read}
        page={t("tabs.runtimes")}
        retry={routes.workSetup(org, ws, "runtimes")}
      />
    );
  const agents = read.value.agents;
  if (agents.length === 0)
    return (
      <StateWrap
        tone="neutral"
        testId="work-targets-empty"
        title={t("runtimes.emptyTitle")}
        actions={
          <SafeLink to={routes.agents(org, ws)} className={buttonPrimary}>
            {t("runtimes.openAgents")}
          </SafeLink>
        }
      >
        {t("runtimes.emptyBody")}
      </StateWrap>
    );
  const ready = agents.filter((agent) => agent.canTake).length;
  return (
    <section aria-labelledby="work-runtimes-title" className={panel}>
      <div className={panelHeader}>
        <h2 id="work-runtimes-title" className={panelTitle}>
          {t("runtimes.title")}
        </h2>
        <span
          data-testid="work-targets-ready"
          className="text-sm text-muted-foreground"
        >
          {t("runtimes.caption", { count: ready })}
        </span>
      </div>
      <div data-testid="work-targets-table">
        <Table
          label={t("runtimes.title")}
          columns={[
            { label: t("runtimes.columns.agent") },
            { label: t("runtimes.columns.runtime") },
            { label: t("runtimes.columns.tier") },
            { label: t("runtimes.columns.send") },
            { label: t("runtimes.columns.budget") },
          ]}
        >
          {agents.map((agent) => (
            <TargetRow key={agent.id} target={agent} />
          ))}
        </Table>
      </div>
      <div className={`${panelBody} border-t border-border`}>
        <p className="text-sm text-muted-foreground">
          {t("runtimes.footNote")}
        </p>
      </div>
    </section>
  );
}
