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
  view,
}: {
  page: AgentPage;
  cursor: string | null;
  view: "composition" | "operations";
} & Place) {
  const t = useTranslations("agents");
  const locale = useLocale();
  const columns = [
    { label: t("list.columns.identity") },
    ...(view === "composition"
      ? [
          { label: t("list.columns.principal") },
          { label: t("list.columns.hosts"), numeric: true },
          { label: t("list.columns.credentials"), numeric: true },
        ]
      : []),
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
            {view === "composition" ? (
              <>
                <td className={cell}>
                  {agent.principalId ?? <NotRecordedValue />}
                </td>
                <td className={numericCell}>
                  {agent.hosts === undefined ? (
                    <NotRecordedValue />
                  ) : (
                    formatCount(agent.hosts, locale)
                  )}
                </td>
                <td className={numericCell}>
                  {agent.credentials === undefined ? (
                    <NotRecordedValue />
                  ) : (
                    formatCount(agent.credentials, locale)
                  )}
                </td>
              </>
            ) : null}
            <td className={`${cell} whitespace-nowrap`}>
              {t(`harness.${agent.harness}`)}
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
            : { to: routes.agents(org, ws, { view }), text: t("list.first") }
        }
        next={
          page.nextCursor === null
            ? null
            : {
                to: routes.agents(org, ws, { cursor: page.nextCursor, view }),
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
  view,
  org,
  ws,
}: {
  read: Read<AgentPage>;
  cursor: string | null;
  workspace: string;
  view: "composition" | "operations";
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
        <IdentityRows
          page={read.value}
          cursor={cursor}
          org={org}
          ws={ws}
          view={view}
        />
      )}
    </Panel>
  );
}

export async function Agents({
  ctx,
  source,
  cursor,
  view = "composition",
}: {
  ctx: WsCtx;
  source: DataSource;
  view?: "composition" | "operations";
  /** The identities page the URL asked for; null is the first. */
  cursor: string | null;
}) {
  const read = await source.agents.list(ctx, { cursor });
  return (
    <div className="flex flex-col gap-3.5">
      {read.ok ? <Tiles totals={read.value.totals} /> : null}
      <ListViews org={ctx.orgSlug} ws={ctx.wsSlug} view={view} />
      <Identities
        read={read}
        view={view}
        cursor={cursor}
        workspace={ctx.wsName}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
      />
    </div>
  );
}

function ListViews({
  org,
  ws,
  view,
}: Place & { view: "composition" | "operations" }) {
  const t = useTranslations("agents.list.views");
  return (
    <nav aria-label={t("label")} className="flex gap-2">
      {(["composition", "operations"] as const).map((name) => (
        <SafeLink
          key={name}
          to={routes.agents(org, ws, { view: name })}
          aria-current={view === name ? "page" : undefined}
          className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm aria-[current=page]:bg-muted"
        >
          {t(name)}
        </SafeLink>
      ))}
    </nav>
  );
}
