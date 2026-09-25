// The Agents page (mockups/pages/agents.md): the registry of actors in this
// workspace. Loaded, it is the header, four tiles and the table of agents with
// its two column sets. Every not-loaded state replaces the page body and never
// the shell, as the design draws it: empty, loading (`AgentsLoading`, the
// Suspense fallback), error and access denied.
//
// **The tiles are rollups of records.** Agents here and Enrolled come from the
// workspace's own count on `list_agents`; Holding a mandate counts the agents
// whose principal holds an active mandate in `tools.mandates`; Tamper
// incidents sums the tamper incidents recorded on each agent's hosts, the set
// the Incidents column reads, and names the newest. Enrolled's "not yet
// enrolled" counts agents whose status is `unenrolled`, so a retired or
// suspended agent is in neither figure. The design scopes the
// last two to the organization; `list_agents` answers for the workspace, so
// each basis line says "counted in <workspace> only" where a touch device can
// read it, and the organization count on Agents here prints as not recorded
// until an organization rollup exists (#3854). "Listed below" is the number
// of rows this read returned, not the workspace total.
//
// **A deregistered agent is a deleted record.** The read leaves retired
// agents out of the rows and every tile (#4332). A small link under the table
// lists them again, and the empty state carries the same link when retired
// agents are all the workspace has.
//
// **Two controls the design asks for have no capability yet.** *Request
// access* (denied, #3820) and *Open an incident* (error, #3847) open dialogs
// that say what they would do (./state-actions.tsx). The trace id, region and
// deciding policy are not on a failed read, so those words print as not
// recorded beside the facts the read does carry.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonSecondary,
  mono,
  panel,
  statStrip,
  statTile,
} from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { AgentsTable } from "./agents-table";
import { RegisterAnAgent, WrapClaudeCode } from "./create-actions";
import { AgentKeyPrefix } from "./key-prefix";
import { keyPrefixOf } from "./key-prefix-of";
import { NotRecordedValue, Tile } from "./parts";
import { OpenIncident, RequestAccess, TryAgain } from "./state-actions";

type Place = { org: string; ws: string };
type Failure = Exclude<Read<unknown>, { ok: true }>;

function Tiles({ page, workspace }: { page: AgentPage; workspace: string }) {
  const t = useTranslations("agents.list.tiles");
  const gaps = useTranslations("agents.list.gaps");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const { totals, agents } = page;
  // Counted by status on the read: a retired or suspended agent is not
  // waiting to enroll, so `identities - enrolled` would overcount.
  const notEnrolled = totals.unenrolled;
  const observe = agents.filter((a) => a.enforcementTier === "observe").length;
  const harness = agents.filter((a) => a.enforcementTier === "harness").length;
  const otherTier = agents.length - observe - harness;
  const { tamper } = totals;
  const newest =
    tamper.newest === null
      ? null
      : {
          key: tamper.newest.agentKey,
          kind: tamper.newest.kind,
          // The day as the record stamps it (UTC), as the design prints it.
          date: tamper.newest.detectedAt.slice(0, 10),
        };
  return (
    <section aria-label={t("label")} className={statStrip}>
      <Tile
        title={t("agentsHere.title")}
        value={count(totals.identities)}
        basis={
          <span data-gap="organization" title={gaps("organization")}>
            {t("agentsHere.basis", { listed: count(agents.length) })}
          </span>
        }
      />
      <Tile
        title={t("enrolled.title")}
        value={count(totals.enrolled)}
        basis={
          notEnrolled > 0
            ? t("enrolled.notYet", { count: count(notEnrolled) })
            : otherTier === 0
              ? t("enrolled.observe", { count: count(observe) })
              : t("enrolled.mixed", {
                  observe: count(observe),
                  harness: count(harness),
                  other: count(otherTier),
                })
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
          ) : (
            <span
              data-scope="workspace"
              title={t("mandate.scope", { workspace })}
            >
              {totals.holdingMandate === 0
                ? t("mandate.none", { workspace })
                : t("mandate.holders", {
                    // The holders the count counted, from the same read,
                    // not the rows on this page.
                    holders: totals.mandateHolders
                      .map((key) => t("mandate.holder", { key, workspace }))
                      .join(", "),
                    workspace,
                  })}
            </span>
          )
        }
      />
      <Tile
        title={t("tamper.title")}
        value={count(tamper.recorded)}
        critical={tamper.recorded > 0}
        basis={
          <span data-scope="workspace" title={t("tamper.scope", { workspace })}>
            {newest === null
              ? t("tamper.none", { workspace })
              : tamper.open > 0
                ? t("tamper.open", {
                    ...newest,
                    count: count(tamper.open),
                    workspace,
                  })
                : t("tamper.resolved", { ...newest, workspace })}
          </span>
        }
      />
    </section>
  );
}

/**
 * The small link that lists retired agents again, or hides them. Nothing
 * when the workspace has none and none are shown, so a workspace that never
 * deregistered an agent never sees it.
 */
function DeregisteredToggle({
  count,
  shown,
  to,
}: {
  count: number;
  shown: boolean;
  to: SafePath;
}) {
  const t = useTranslations("agents.list.controls");
  const locale = useLocale();
  if (!shown && count === 0) return null;
  return (
    <SafeLink
      to={to}
      data-testid="agents-deregistered-toggle"
      className="self-start rounded-sm text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {shown
        ? t("hideDeregistered")
        : t("showDeregistered", { count: formatCount(count, locale) })}
    </SafeLink>
  );
}

function Empty({
  workspace,
  org,
  ws,
  retired,
}: { workspace: string; retired: ReactNode } & Place) {
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
      <span className="flex flex-col gap-3">
        <span>
          {t.rich("body", {
            mono: (chunks) => <span className={mono}>{chunks}</span>,
          })}
        </span>
        {retired}
      </span>
    </OutcomePanel>
  );
}

function Denied({
  read,
  ctx,
  viewerName,
}: {
  read: Extract<Failure, { reason: "denied" }>;
  ctx: WsCtx;
  viewerName: string;
}) {
  const t = useTranslations("agents.list.states.denied");
  const gaps = useTranslations("agents.list.gaps");
  const needed = t("neededValue", {
    permission: read.permission,
    ws: ctx.wsSlug,
  });
  const facts: readonly [string, ReactNode][] = [
    [
      t("signedIn"),
      <span key="who">
        {t("signedInValue", {
          name: viewerName,
          role: ctx.wsRole,
          ws: ctx.wsSlug,
        })}
      </span>,
    ],
    [
      t("needed"),
      <span key="needed" className={mono}>
        {needed}
      </span>,
    ],
    [
      t("decidedBy"),
      <span key="decided">
        {t.rich("decidedByValue", {
          policy: () => (
            <span
              data-gap="policy"
              title={gaps("policy")}
              className={`${mono} text-muted-foreground`}
            >
              {t("policyUnrecorded")}
            </span>
          ),
        })}
      </span>,
    ],
  ];
  return (
    <OutcomePanel
      tone="deny"
      testId="agents-denied"
      title={t("title")}
      actions={
        <>
          <RequestAccess org={ctx.orgSlug} permission={needed} />
          <SafeLink
            to={routes.fleet(ctx.orgSlug, ctx.wsSlug)}
            className={buttonSecondary}
          >
            {t("back")}
          </SafeLink>
        </>
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
  readAt,
}: {
  read: Extract<Failure, { reason: "error" }>;
  readAt: Date;
}) {
  const t = useTranslations("agents.list.states.error");
  const gaps = useTranslations("agents.list.gaps");
  const code = `${String(read.status)} ${read.code}`;
  return (
    <OutcomePanel
      tone="neutral"
      testId="agents-error"
      title={t("title")}
      actions={
        <>
          <TryAgain />
          <OpenIncident code={code} />
        </>
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
        <span data-testid="agents-trace" className={`${mono} text-xs`}>
          {t.rich("trace", {
            // The design's stamp: the instant the read failed, in UTC.
            at: `${readAt.toISOString().slice(0, 19).replace("T", " ")}Z`,
            trace: () => (
              <span data-gap="trace" title={gaps("trace")}>
                {t("traceUnrecorded")}
              </span>
            ),
            region: () => (
              <span data-gap="trace" title={gaps("trace")}>
                {t("regionUnrecorded")}
              </span>
            ),
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
  showRetired = false,
  header,
  viewerName,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The signed-in person's name, or their email when the account has none; the denied state names them. */
  viewerName: string;
  /** The agents page the URL asked for; null is the first. */
  cursor: string | null;
  /** List retired (deregistered) agents beside the live ones; the URL's `deregistered=show`. */
  showRetired?: boolean;
  /** The page header, drawn only when the page has agents to show. */
  header: ReactNode;
}) {
  const read = await source.agents.list(ctx, {
    cursor,
    includeRetired: showRetired,
  });
  const readAt = instantAfterRead();
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug };
  if (!read.ok) {
    switch (read.reason) {
      case "denied":
        return <Denied read={read} ctx={ctx} viewerName={viewerName} />;
      case "pending_approval":
        return <Pending request={read.accessRequestId} />;
      case "error":
        return <ReadError read={read} readAt={readAt} />;
    }
  }
  const page = read.value;
  const retired = (
    <DeregisteredToggle
      count={page.totals.retired}
      shown={showRetired}
      to={routes.agents(place.org, place.ws, { deregistered: !showRetired })}
    />
  );
  if (page.agents.length === 0 && cursor === null)
    return <Empty workspace={ctx.wsName} {...place} retired={retired} />;
  return (
    <AgentKeyPrefix value={keyPrefixOf(page.agents.map((a) => a.agentKey))}>
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
              : routes.agents(place.org, place.ws, {
                  cursor: page.nextCursor,
                  deregistered: showRetired,
                })
          }
          first={
            cursor === null
              ? null
              : routes.agents(place.org, place.ws, {
                  deregistered: showRetired,
                })
          }
          retired={retired}
        />
      </div>
    </AgentKeyPrefix>
  );
}

/** Four tile blocks and a panel of seven rows (agents.md, loading). */
const TILES = [0, 1, 2, 3];
const ROWS = [0, 1, 2, 3, 4, 5, 6];
/** The design's `.sk` shimmer (globals.css), the one every skeleton draws. */
const bone = "skeleton rounded-md";

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
