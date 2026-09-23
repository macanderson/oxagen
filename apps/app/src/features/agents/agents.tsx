import { HarnessLabel } from "@/ui/harness-icon";
// Agent IAM (ARCHITECTURE.md §1.2 Agents row, #2956): the workspace's
// identities from one list_agents page. The tiles count the whole workspace
// (the contract's totals); the table is the page. A figure no store records
// (tier, belt size, mandates) has no column: it renders nothing
// until its lane lands (§3.6).
import { useLocale, useTranslations } from "next-intl";
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { RetireAgent } from "./agent-actions";
import {
  AgentStatusBadge,
  NotRecordedValue,
  Pager,
  Panel,
  Tile,
} from "./parts";

type Place = { org: string; ws: string };

function Tiles({ totals }: { totals: AgentPage["totals"] }) {
  const t = useTranslations("agents.list.tiles");
  const locale = useLocale();
  return (
    <section aria-label={t("label")} className="grid gap-3 sm:grid-cols-3">
      <Tile
        title={t("identities.title")}
        value={formatCount(totals.identities, locale)}
        basis={t("identities.basis")}
      />
      <Tile
        title={t("enrolled.title")}
        value={formatCount(totals.enrolled, locale)}
        basis={t("enrolled.basis", {
          count: formatCount(totals.identities, locale),
        })}
      />
      <Tile
        title={t("tamper.title")}
        value={formatCount(totals.tamperIncidents, locale)}
        basis={t("tamper.basis")}
      />
    </section>
  );
}

function EmptyIdentities({ workspace }: { workspace: string }) {
  const t = useTranslations("agents.list.empty");
  return (
    <div
      data-testid="agents-empty"
      className="flex flex-col items-center gap-2 py-6 text-center text-sm"
    >
      <h3 className="font-semibold">{t("title", { workspace })}</h3>
      <p className="max-w-prose text-muted-foreground">{t("body")}</p>
      <p className="max-w-prose text-muted-foreground">{t("register")}</p>
      <code className={`${mono} rounded-md bg-muted px-2 py-1`}>
        {t("command")}
      </code>
    </div>
  );
}

function IdentityRows({
  page,
  cursor,
  org,
  ws,
}: { page: AgentPage; cursor: string | null } & Place) {
  const t = useTranslations("agents");
  const locale = useLocale();
  const columns = [
    { label: t("list.columns.identity") },
    { label: t("list.columns.harness") },
    { label: t("list.columns.operator") },
    { label: t("list.columns.status") },
    { label: t("list.columns.runs"), numeric: true },
    { label: t("list.columns.spend"), numeric: true },
    { label: t("list.columns.incidents"), numeric: true },
    { label: t("list.columns.actions") },
  ];
  return (
    <>
      <Table label={t("list.tableLabel")} columns={columns}>
        {page.agents.map((agent) => (
          <tr key={agent.id} data-testid="agent-row">
            <td className={cell}>
              <SafeLink
                to={routes.agent(org, ws, agent.slug)}
                className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
              >
                <AgentCard
                  agentKey={agent.agentKey}
                  notRecorded={t("notRecorded")}
                  sub={agent.name}
                />
              </SafeLink>
            </td>
            <td className={`${cell} whitespace-nowrap`}>
              <HarnessLabel harness={agent.harness}>
                {t(`harness.${agent.harness}`)}
              </HarnessLabel>
            </td>
            <td className={cell}>
              {agent.operatorId === null ? (
                <NotRecordedValue />
              ) : (
                // `list_agents` carries the operator's id and no name yet, so
                // the id is the label until it does; the card keeps it copyable.
                <OperatorName
                  operator={{ id: agent.operatorId, name: null, kind: null }}
                >
                  <span className={mono}>{agent.operatorId}</span>
                </OperatorName>
              )}
            </td>
            <td className={cell}>
              <AgentStatusBadge status={agent.status} />
            </td>
            <td className={numericCell}>
              {formatCount(agent.runs30d, locale)}
            </td>
            <td className={numericCell}>
              {agent.spend30d === null ? (
                <NotRecordedValue />
              ) : (
                <>
                  <Money value={agent.spend30d} />
                  <span className="block font-mono text-[10.5px] text-muted-foreground">
                    {agent.spend30d.basis ?? t("list.basisNotRecorded")}
                  </span>
                </>
              )}
            </td>
            <td className={numericCell}>
              {formatCount(agent.incidents, locale)}
            </td>
            <td className={cell}>
              <span className="flex items-center gap-2 whitespace-nowrap">
                <SafeLink
                  to={routes.agent(org, ws, agent.slug, { tab: "definition" })}
                  className={linkText}
                >
                  {t("list.edit")}
                </SafeLink>
                {agent.status === "retired" ? null : (
                  <RetireAgent
                    org={org}
                    ws={ws}
                    agentId={agent.id}
                    name={agent.name}
                    after={routes.agents(org, ws)}
                  />
                )}
              </span>
            </td>
          </tr>
        ))}
      </Table>
      <Pager
        label={t("list.pager")}
        first={
          cursor === null
            ? null
            : { to: routes.agents(org, ws), text: t("list.first") }
        }
        next={
          page.nextCursor === null
            ? null
            : {
                to: routes.agents(org, ws, { cursor: page.nextCursor }),
                text: t("list.next"),
              }
        }
      />
    </>
  );
}

function Identities({
  read,
  cursor,
  workspace,
  org,
  ws,
}: {
  read: Read<AgentPage>;
  cursor: string | null;
  workspace: string;
} & Place) {
  const t = useTranslations("agents.list");
  const title = t("title", { workspace });
  return (
    <Panel id="agents-identities" title={title}>
      {!read.ok ? (
        <ReadFailure read={read} section={title} />
      ) : read.value.agents.length === 0 && cursor === null ? (
        <EmptyIdentities workspace={workspace} />
      ) : (
        <IdentityRows page={read.value} cursor={cursor} org={org} ws={ws} />
      )}
    </Panel>
  );
}

export async function Agents({
  ctx,
  source,
  cursor,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The identities page the URL asked for; null is the first. */
  cursor: string | null;
}) {
  const read = await source.agents.list(ctx, { cursor });
  return (
    <div className="flex flex-col gap-3.5">
      {read.ok ? <Tiles totals={read.value.totals} /> : null}
      <Identities
        read={read}
        cursor={cursor}
        workspace={ctx.wsName}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
      />
    </div>
  );
}
