// The Agents page (mockups/pages/agents.md): the registry of actors in this
// workspace. Loaded, it is the header, four tiles and the table of agents with
// its two column sets. Every not-loaded state replaces the page body and never
// the shell, as the design draws it: empty, loading (`AgentsLoading`, the
// Suspense fallback), error and access denied.
//
// **The tiles are rollups of records.** Agents here and Enrolled come from the
// workspace's own count on `list_agents`; Holding a mandate counts the agents
// whose principal holds an active mandate in `tools.mandates`; Tamper
// incidents counts the open incidents of a tamper kind on the workspace's
// hosts, the same set the Audit page and the Incidents column read. The
// design scopes the last two to the organization; `list_agents` answers for
// the workspace, so the basis lines name the workspace, and the organization
// count on Agents here prints as not recorded until an organization rollup
// exists.
//
// **Two controls the design asks for are not drawn, and neither is stubbed.**
// *Request access* (denied) and *Open an incident* (error) have no contract:
// no capability lets a person ask for a role or file an incident. The copy
// names the route that does exist, as the Mandate and Record pages do.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import {
  buttonSecondary,
  mono,
  panel,
  statStrip,
  statTile,
} from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { AgentsTable } from "./agents-table";
import { RegisterAnAgent, WrapClaudeCode } from "./create-actions";
import { NotRecordedValue, Tile } from "./parts";

type Place = { org: string; ws: string };
type Failure = Exclude<Read<unknown>, { ok: true }>;

/** How many holders the Holding a mandate basis names before it counts the rest. */
const HOLDERS_NAMED = 3;

function Tiles({ page, workspace }: { page: AgentPage; workspace: string }) {
  const t = useTranslations("agents.list.tiles");
  const gaps = useTranslations("agents.list.gaps");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const { totals, agents } = page;
  const notEnrolled = totals.identities - totals.enrolled;
  const observe = agents.filter((a) => a.enforcementTier === "observe").length;
  const holders = agents.filter((a) => (a.mandates ?? 0) > 0);
  const named = holders.slice(0, HOLDERS_NAMED);
  const unnamed =
    totals.holdingMandate === null
      ? 0
      : Math.max(0, totals.holdingMandate - named.length);
  return (
    <section aria-label={t("label")} className={statStrip}>
      <Tile
        title={t("agentsHere.title")}
        value={count(totals.identities)}
        basis={
          <span data-gap="organization" title={gaps("organization")}>
            {t("agentsHere.basis", { listed: count(totals.identities) })}
          </span>
        }
      />
      <Tile
        title={t("enrolled.title")}
        value={count(totals.enrolled)}
        basis={
          notEnrolled > 0
            ? t("enrolled.notYet", { count: count(notEnrolled) })
            : t("enrolled.observe", { count: count(observe) })
        }
      />
      <Tile
        title={t("mandate.title")}
        value={
          totals.holdingMandate === null ? (
            <NotRecordedValue />
          ) : (
            count(totals.holdingMandate)
          )
        }
        basis={
          totals.holdingMandate === null ? (
            <NotRecordedValue />
          ) : totals.holdingMandate === 0 ? (
            t("mandate.none")
          ) : (
            [
              ...named.map((a) =>
                t("mandate.holder", { key: a.agentKey ?? a.slug, workspace }),
              ),
              ...(unnamed > 0
                ? [t("mandate.more", { count: count(unnamed), workspace })]
                : []),
            ].join(", ")
          )
        }
      />
      <Tile
        title={t("tamper.title")}
        value={count(totals.tamperIncidents)}
        critical={totals.tamperIncidents > 0}
        basis={
          totals.tamperIncidents > 0
            ? t("tamper.open", {
                count: count(totals.tamperIncidents),
                workspace,
              })
            : t("tamper.none", { workspace })
        }
      />
    </section>
  );
}

function Empty({ workspace, org, ws }: { workspace: string } & Place) {
  const t = useTranslations("agents.list.empty");
  return (
    <OutcomePanel
      tone="neutral"
      testId="agents-empty"
      title={t("title", { workspace })}
      actions={
        <>
          <WrapClaudeCode org={org} ws={ws} />
          <RegisterAnAgent org={org} ws={ws} />
        </>
      }
    >
      {t.rich("body", {
        mono: (chunks) => <span className={mono}>{chunks}</span>,
      })}
    </OutcomePanel>
  );
}

function Denied({
  read,
  ctx,
}: {
  read: Extract<Failure, { reason: "denied" }>;
  ctx: WsCtx;
}) {
  const t = useTranslations("agents.list.states.denied");
  const facts: readonly [string, ReactNode][] = [
    [
      t("signedIn"),
      <span key="who" className={mono}>
        {t("signedInValue", { role: ctx.wsRole, ws: ctx.wsSlug })}
      </span>,
    ],
    [
      t("needed"),
      <span key="needed" className={mono}>
        {t("neededValue", { permission: read.permission, ws: ctx.wsSlug })}
      </span>,
    ],
    [t("decidedBy"), t("decidedByValue")],
  ];
  return (
    <OutcomePanel
      tone="deny"
      testId="agents-denied"
      title={t("title")}
      actions={
        <SafeLink
          to={routes.fleet(ctx.orgSlug, ctx.wsSlug)}
          className={buttonSecondary}
        >
          {t("back")}
        </SafeLink>
      }
    >
      <span className="flex flex-col gap-3">
        <span>
          {t.rich("body", {
            org: ctx.orgName,
            permission: read.permission,
            ws: ctx.wsSlug,
            strong: (chunks) => (
              <strong className="font-semibold text-foreground">
                {chunks}
              </strong>
            ),
            mono: (chunks) => <span className={mono}>{chunks}</span>,
          })}
        </span>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left text-xs">
          {facts.map(([term, value]) => (
            <div key={term} className="contents">
              <dt>{term}</dt>
              <dd className="text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </span>
    </OutcomePanel>
  );
}

function ReadError({
  read,
  ctx,
  readAt,
}: {
  read: Extract<Failure, { reason: "error" }>;
  ctx: WsCtx;
  readAt: Date;
}) {
  const t = useTranslations("agents.list.states.error");
  const format = useFormatter();
  return (
    <OutcomePanel
      tone="neutral"
      testId="agents-error"
      title={t("title")}
      actions={
        <SafeLink
          to={routes.agents(ctx.orgSlug, ctx.wsSlug)}
          className={buttonSecondary}
        >
          {t("retry")}
        </SafeLink>
      }
    >
      <span className="flex flex-col gap-2">
        <span>
          {t.rich("body", {
            status: String(read.status),
            code: read.code,
            mono: (chunks) => <span className={mono}>{chunks}</span>,
          })}
        </span>
        <span className={`${mono} text-xs`}>
          {t("readAt", {
            at: format.dateTime(readAt, {
              dateStyle: "medium",
              timeStyle: "long",
            }),
          })}
        </span>
      </span>
    </OutcomePanel>
  );
}

function Pending({ request }: { request: string }) {
  const t = useTranslations("agents.list.states.pending");
  return (
    <OutcomePanel tone="neutral" testId="agents-pending" title={t("title")}>
      {t("body", { request })}
    </OutcomePanel>
  );
}

/**
 * The instant the read answered. Outside the component so the purity rule,
 * which is syntactic, does not read an async server component's once-per-
 * request clock as a render-time impurity (as `features/mandate` does).
 */
function instantAfterRead(): Date {
  return new Date();
}

export async function Agents({
  ctx,
  source,
  cursor,
  header,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The agents page the URL asked for; null is the first. */
  cursor: string | null;
  /** The page header, drawn only when the page has agents to show. */
  header: ReactNode;
}) {
  const read = await source.agents.list(ctx, { cursor });
  const readAt = instantAfterRead();
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug };
  if (!read.ok) {
    switch (read.reason) {
      case "denied":
        return <Denied read={read} ctx={ctx} />;
      case "pending_approval":
        return <Pending request={read.accessRequestId} />;
      case "error":
        return <ReadError read={read} ctx={ctx} readAt={readAt} />;
    }
  }
  const page = read.value;
  if (page.agents.length === 0 && cursor === null)
    return <Empty workspace={ctx.wsName} {...place} />;
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <Tiles page={page} workspace={ctx.wsName} />
        <AgentsTable
          rows={page.agents}
          org={place.org}
          ws={place.ws}
          workspace={ctx.wsName}
          more={
            page.nextCursor === null
              ? null
              : routes.agents(place.org, place.ws, { cursor: page.nextCursor })
          }
          first={cursor === null ? null : routes.agents(place.org, place.ws)}
        />
      </div>
    </>
  );
}

/** Four tile blocks and a panel of seven rows (agents.md, loading). */
const TILES = [0, 1, 2, 3];
const ROWS = [0, 1, 2, 3, 4, 5, 6];
const bone = "animate-pulse rounded bg-muted motion-reduce:animate-none";

export function AgentsLoading() {
  const t = useTranslations("agents.list.states");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="agents-loading"
      className="flex flex-col gap-4"
    >
      <span className="sr-only">{t("loading")}</span>
      <div className={statStrip}>
        {TILES.map((tile) => (
          <span key={tile} aria-hidden="true" className={statTile}>
            <span className={`mb-2 block h-2.5 w-20 ${bone}`} />
            <span className={`block h-6 w-16 ${bone}`} />
            <span className={`mt-2 block h-2.5 w-28 ${bone}`} />
          </span>
        ))}
      </div>
      <div className={`${panel} flex flex-col gap-3 p-4`}>
        <span aria-hidden="true" className={`h-4 w-44 ${bone}`} />
        {ROWS.map((row) => (
          <span key={row} aria-hidden="true" className={`h-9 ${bone}`} />
        ))}
      </div>
    </div>
  );
}
