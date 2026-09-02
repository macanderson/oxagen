/**
 * Org dashboard — the org home (`/{org}` redirects here). The metering/usage
 * cockpit for a whole organization: a core stat strip with period-over-period
 * deltas, a dynamic capability-pack strip, and per-model / per-surface /
 * per-workspace / per-user breakdowns.
 *
 * Reads the billing.usage.breakdown capability (grouped ClickHouse token_usage
 * aggregates) for the selected window AND the immediately-preceding window (for
 * the delta chips), through invoke() so the read is observed like every
 * capability. apps/app does not bootstrap kernel IAM, so the caller is gated
 * explicitly (assertOrgMember for the page, assertBillingManager for the cost
 * tiles — usage counts are visible to every member, spend is billing-gated).
 *
 * Resilience: the invoke is wrapped so a ClickHouse outage degrades to zeros
 * with a notice rather than a 500. An org with no workspaces yet renders a
 * first-run empty state instead of erroring.
 *
 * Spec: docs/specs/usage-analytics.
 */

import Link from "next/link";
import { invoke } from "@oxagen/oxagen";
// Side-effect import binds every handler into the kernel — without it invoke()
// throws "No handler registered". Mirrors the other app-side invoke call sites.
import "@oxagen/handlers/register";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import {
  resolveOrg,
  assertOrgMember,
  assertBillingManager,
} from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Panel } from "@/components/ui/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { logger } from "@oxagen/handlers/logger";
import { UsageBreakdownView } from "../billing/usage/usage-breakdown-view";
import { UsageRangePicker } from "../billing/usage/usage-range-picker";
import {
  parseRange,
  rangeToWindow,
  rangeLabel,
  formatTokens,
  formatUsdFromMicros,
} from "../billing/usage/usage-format";

// Sentinel workspaceId for org-only routes.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const EMPTY: BillingUsageBreakdownOutput = {
  range: { start: "", end: "" },
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 0,
    executions: 0,
    messages: 0,
  },
  cacheSavingsMicros: 0,
  series: [],
  byModel: [],
  bySurface: [],
  byWorkspace: [],
  byCapability: [],
  byPrincipal: [],
  byUser: [],
};

/** Period-over-period change for a Stat tile. `goodUp` sets the sentiment. */
function delta(
  current: number,
  previous: number,
  goodUp = true,
): {
  delta: string;
  trend: "up" | "down" | "flat";
  intent: "positive" | "negative" | "neutral";
} {
  const trend: "up" | "down" | "flat" =
    current > previous ? "up" : current < previous ? "down" : "flat";
  if (previous === 0) {
    return { delta: current > 0 ? "new" : "0%", trend, intent: "neutral" };
  }
  const pct = ((current - previous) / previous) * 100;
  const abs = Math.abs(pct);
  const label = `${pct >= 0 ? "+" : "−"}${abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)}%`;
  const good = trend === "flat" ? null : (trend === "up") === goodUp;
  return {
    delta: label,
    trend,
    intent: good === null ? "neutral" : good ? "positive" : "negative",
  };
}

/** Cache-read share: cached ÷ input tokens, as a whole-percent. */
function cacheShare(t: BillingUsageBreakdownOutput["totals"]): number {
  return t.inputTokens > 0
    ? Math.round((t.cachedTokens / t.inputTokens) * 100)
    : 0;
}

// Capability-pack display grouping — the DATA is always the distinct set of
// capability_name values seen in the window (never a hard-coded list); this map
// only assigns a friendly family label + order to the ones we recognise.
const CAP_LABELS: Record<string, string> = {
  generate_image: "Images",
  create_image: "Images",
  generate_video: "Videos",
  create_pdf: "PDFs",
  generate_document: "Documents",
  generate_svg: "SVG",
  generate_mermaid: "Diagrams",
  generate_markdown: "Markdown",
};

export default async function OrgDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);
  const [org, session] = await Promise.all([
    resolveOrg(orgSlug),
    getSessionOrRedirect(),
  ]);

  // getSessionOrRedirect guarantees a signed-in user, so the membership gate is
  // unconditional: an anonymous (or stale-cookie) visitor never reaches the org
  // usage read below.
  const viewerUserId = session.user.id;
  await assertOrgMember(org.id, viewerUserId);
  // Spend is gated to owner/admin/billing roles; usage counts are not.
  let canSeeCost = false;
  try {
    await assertBillingManager(org.id, viewerUserId);
    canSeeCost = true;
  } catch {
    canSeeCost = false;
  }

  const rangeKey = parseRange(sp.range);
  const { start, end } = rangeToWindow(rangeKey);
  // Immediately-preceding equal-length window drives the delta chips.
  const durationMs = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - durationMs);
  const prevEnd = start;
  const basePath = `/${orgSlug}/dashboard`;

  const workspaceNames: Record<string, string> = {};
  const userNames: Record<string, string> = {};

  const { breakdown, previous, queryFailed, workspaceCount } =
    await runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WS },
      async () => {
        let wsCount = 0;
        try {
          const wsRows = await withTenantDb((tx) =>
            tx
              .select({
                id: schema.workspaces.id,
                name: schema.workspaces.name,
              })
              .from(schema.workspaces)
              .where(eq(schema.workspaces.orgId, org.id)),
          );
          wsCount = wsRows.length;
          for (const w of wsRows) workspaceNames[w.id] = w.name;
        } catch (err) {
          logger.warn(
            { err, orgId: org.id },
            "org/dashboard: workspace resolve failed",
          );
        }

        const ctx = {
          orgId: org.id,
          workspaceId: ORG_ONLY_WS,
          userId: viewerUserId,
          apiKeyId: null as string | null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null as string | null,
        };
        const runWindow = async (
          s: Date,
          e: Date,
        ): Promise<BillingUsageBreakdownOutput> =>
          (await invoke(
            "get_usage_breakdown",
            { start: s.toISOString(), end: e.toISOString() },
            ctx,
            { surface: "agent" },
          )) as BillingUsageBreakdownOutput;

        let cur = EMPTY;
        let prev = EMPTY;
        let failed = false;
        try {
          [cur, prev] = await Promise.all([
            runWindow(start, end),
            runWindow(prevStart, prevEnd),
          ]);
        } catch (err) {
          logger.error(
            { err, orgId: org.id },
            "org/dashboard: breakdown invoke failed",
          );
          failed = true;
        }

        // Resolve acting-user display names (best-effort; never surface raw ids).
        const userIds = cur.byUser
          .map((r) => r.userId)
          .filter((id) => id && id !== ORG_ONLY_WS);
        if (userIds.length > 0) {
          try {
            const rows = await withTenantDb((tx) =>
              tx
                .select({
                  id: schema.users.id,
                  displayName: schema.users.displayName,
                  email: schema.users.email,
                })
                .from(schema.users)
                .where(inArray(schema.users.id, userIds)),
            );
            for (const u of rows) userNames[u.id] = u.displayName || u.email;
          } catch (err) {
            logger.warn(
              { err, orgId: org.id },
              "org/dashboard: user name resolve failed",
            );
          }
        }

        return {
          breakdown: cur,
          previous: prev,
          queryFailed: failed,
          workspaceCount: wsCount,
        };
      },
    );

  const t = breakdown.totals;
  const p = previous.totals;
  const totalTokens = t.inputTokens + t.outputTokens;
  const prevTotalTokens = p.inputTokens + p.outputTokens;

  // Distinct-capability rollup for the capability-pack strip (data-driven).
  const capRollup = [...breakdown.byCapability]
    .filter((r) => r.key)
    .sort((a, b) => b.executions - a.executions)
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-6" data-testid="org-dashboard">
      {/* Header + range */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Usage across all workspaces · last{" "}
            {rangeLabel(rangeKey).toLowerCase()}
          </p>
        </div>
        <UsageRangePicker basePath={basePath} active={rangeKey} />
      </div>

      {workspaceCount === 0 ? (
        <Panel className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-foreground">
            No workspaces yet
          </p>
          <p className="text-sm text-muted-foreground">
            Usage appears here once a workspace has activity. Create your first
            workspace to get started.
          </p>
          <Link
            href={`/${orgSlug}/new-workspace`}
            className="mt-1 inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Create a workspace
          </Link>
        </Panel>
      ) : null}

      {queryFailed ? (
        <p className="text-xs text-destructive">
          Usage data is temporarily unavailable — the analytics query failed.
          Showing zeros.
        </p>
      ) : null}

      {/* Core stat strip — deltas vs the preceding window */}
      <StatGroup columns={4}>
        <Stat
          label="Executions"
          value={t.executions.toLocaleString()}
          {...delta(t.executions, p.executions)}
          hint="metered LLM calls"
        />
        <Stat
          label="Chat turns"
          value={t.messages.toLocaleString()}
          {...delta(t.messages, p.messages)}
          hint="distinct message steps"
        />
        <Stat
          label="Total tokens"
          value={formatTokens(totalTokens)}
          {...delta(totalTokens, prevTotalTokens)}
          hint={`${t.inputTokens.toLocaleString()} in · ${t.outputTokens.toLocaleString()} out`}
        />
        {canSeeCost ? (
          <Stat
            label="Cost"
            value={formatUsdFromMicros(t.costMicros)}
            {...delta(t.costMicros, p.costMicros, false)}
            hint="metered spend this window"
          />
        ) : (
          <Stat
            label="Cost"
            value="—"
            hint="visible to billing managers"
            tone="neutral"
          />
        )}
      </StatGroup>

      <StatGroup columns={4}>
        <Stat
          label="Tokens in"
          value={formatTokens(t.inputTokens)}
          {...delta(t.inputTokens, p.inputTokens)}
          hint="prompt tokens"
        />
        <Stat
          label="Tokens out"
          value={formatTokens(t.outputTokens)}
          {...delta(t.outputTokens, p.outputTokens)}
          hint="completion tokens"
        />
        <Stat
          label="Cache-read share"
          value={`${cacheShare(t)}%`}
          {...delta(cacheShare(t), cacheShare(p))}
          hint="cached ÷ input tokens"
        />
        <Stat
          label="Capabilities used"
          value={breakdown.byCapability
            .filter((r) => r.key)
            .length.toLocaleString()}
          hint="distinct capabilities this window"
        />
      </StatGroup>

      {/* Capability-pack strip — distinct capabilities, counts derived */}
      {capRollup.length > 0 ? (
        <Panel className="flex flex-col gap-3 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Capability usage
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Capability</TableHead>
                  <TableHead className="text-right">Uses</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  {canSeeCost ? (
                    <TableHead className="text-right">Cost</TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {capRollup.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">
                      {CAP_LABELS[r.key] ? (
                        <span>
                          {CAP_LABELS[r.key]}{" "}
                          <span className="text-xs text-muted-foreground">
                            {r.key}
                          </span>
                        </span>
                      ) : (
                        r.key
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.executions.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(r.inputTokens + r.outputTokens)}
                    </TableCell>
                    {canSeeCost ? (
                      <TableCell className="text-right tabular-nums">
                        {formatUsdFromMicros(r.costMicros)}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
      ) : null}

      {/* Charts + per-model / per-surface / per-workspace tables */}
      <UsageBreakdownView
        series={breakdown.series}
        byModel={breakdown.byModel}
        bySurface={breakdown.bySurface}
        byWorkspace={breakdown.byWorkspace}
        workspaceNames={workspaceNames}
      />

      {/* Per-user breakdown — seat-level "who used it" */}
      {breakdown.byUser.filter((r) => r.userId && r.userId !== ORG_ONLY_WS)
        .length > 0 ? (
        <Panel className="flex flex-col gap-3 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            By user
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Executions</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  {canSeeCost ? (
                    <TableHead className="text-right">Cost</TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {breakdown.byUser
                  .filter((r) => r.userId && r.userId !== ORG_ONLY_WS)
                  .sort((a, b) => b.costMicros - a.costMicros)
                  .slice(0, 10)
                  .map((r) => (
                    <TableRow key={r.userId}>
                      <TableCell className="font-medium">
                        {userNames[r.userId] ?? `User ••${r.userId.slice(-4)}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.executions.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatTokens(r.inputTokens + r.outputTokens)}
                      </TableCell>
                      {canSeeCost ? (
                        <TableCell className="text-right tabular-nums">
                          {formatUsdFromMicros(r.costMicros)}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
