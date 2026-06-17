"use client";

import * as React from "react";
import { AreaChart, AreaSeries, LinearXAxis, LinearXAxisTickSeries, LinearXAxisTickLabel, LinearYAxis, LinearYAxisTickSeries, GridlineSeries } from "reaviz";
import { Card, CardHeader, CardTitle, CardDescription, CardPanel } from "@/components/ui/card";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Static mock data — 30-day credit burn (1 credit = 1¢)
// ---------------------------------------------------------------------------

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Daily credit spend (cents) over the current billing period. */
const BURN_DATA: Array<{ key: Date; data: number }> = [
  { key: daysAgo(29), data: 312 },
  { key: daysAgo(28), data: 488 },
  { key: daysAgo(27), data: 295 },
  { key: daysAgo(26), data: 610 },
  { key: daysAgo(25), data: 740 },
  { key: daysAgo(24), data: 530 },
  { key: daysAgo(23), data: 420 },
  { key: daysAgo(22), data: 890 },
  { key: daysAgo(21), data: 1020 },
  { key: daysAgo(20), data: 775 },
  { key: daysAgo(19), data: 640 },
  { key: daysAgo(18), data: 980 },
  { key: daysAgo(17), data: 1150 },
  { key: daysAgo(16), data: 870 },
  { key: daysAgo(15), data: 720 },
  { key: daysAgo(14), data: 1340 },
  { key: daysAgo(13), data: 1590 },
  { key: daysAgo(12), data: 1210 },
  { key: daysAgo(11), data: 1080 },
  { key: daysAgo(10), data: 1460 },
  { key: daysAgo(9), data: 1680 },
  { key: daysAgo(8), data: 1320 },
  { key: daysAgo(7), data: 1550 },
  { key: daysAgo(6), data: 1890 },
  { key: daysAgo(5), data: 2100 },
  { key: daysAgo(4), data: 1750 },
  { key: daysAgo(3), data: 2340 },
  { key: daysAgo(2), data: 2580 },
  { key: daysAgo(1), data: 2210 },
  { key: daysAgo(0), data: 1480 },
];

const TOTAL_SPENT_CENTS = BURN_DATA.reduce((s, d) => s + d.data, 0);
const INCLUDED_CENTS = 10_000; // $100 / 10 000 credits included on Build plan
const PROJECTED_CENTS = Math.round((TOTAL_SPENT_CENTS / 29) * 30);

const INPUT_TOKENS = 24_812_450;
const OUTPUT_TOKENS = 6_203_180;
const TOTAL_TOKENS = INPUT_TOKENS + OUTPUT_TOKENS;
// Input tokens: 0.30/M input · Output: 1.50/M output (Build-plan rate card)
const INPUT_COST_CENTS = Math.round((INPUT_TOKENS / 1_000_000) * 30);
const OUTPUT_COST_CENTS = Math.round((OUTPUT_TOKENS / 1_000_000) * 150);
const TOKEN_COST_CENTS = INPUT_COST_CENTS + OUTPUT_COST_CENTS;

interface ModelRow {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

const MODEL_ROWS: ModelRow[] = [
  {
    model: "claude-sonnet-4-5",
    provider: "Anthropic",
    calls: 4_812,
    inputTokens: 14_230_100,
    outputTokens: 3_850_420,
    costCents: TOKEN_COST_CENTS * 0.52,
  },
  {
    model: "claude-haiku-3-5",
    provider: "Anthropic",
    calls: 8_941,
    inputTokens: 7_980_200,
    outputTokens: 1_640_080,
    costCents: TOKEN_COST_CENTS * 0.18,
  },
  {
    model: "gpt-4o",
    provider: "OpenAI",
    calls: 1_203,
    inputTokens: 1_890_600,
    outputTokens: 520_140,
    costCents: TOKEN_COST_CENTS * 0.19,
  },
  {
    model: "gemini-2.0-flash",
    provider: "Google",
    calls: 620,
    inputTokens: 711_550,
    outputTokens: 192_540,
    costCents: TOKEN_COST_CENTS * 0.11,
  },
];

interface CapabilityRow {
  capability: string;
  category: string;
  calls: number;
  costCents: number;
}

const CAPABILITY_ROWS: CapabilityRow[] = [
  { capability: "agent.run", category: "Agent", calls: 3_210, costCents: 8_420 },
  { capability: "knowledge.search", category: "Knowledge Graph", calls: 9_481, costCents: 2_840 },
  { capability: "content.generate", category: "Content Studio", calls: 2_108, costCents: 5_370 },
  { capability: "connector.sync", category: "Connectors", calls: 1_440, costCents: 1_210 },
  { capability: "chat.stream", category: "Chat", calls: 6_590, costCents: 3_960 },
  { capability: "automation.trigger", category: "Automation", calls: 880, costCents: 650 },
  { capability: "media.render", category: "Media", calls: 312, costCents: 4_180 },
  { capability: "tool.call", category: "Tools", calls: 12_340, costCents: 1_890 },
];

interface WorkspaceRow {
  workspace: string;
  calls: number;
  tokens: number;
  costCents: number;
  pct: number;
}

const WORKSPACE_ROWS: WorkspaceRow[] = [
  { workspace: "production", calls: 18_420, tokens: 17_840_290, costCents: 18_320, pct: 52 },
  { workspace: "engineering", calls: 9_810, tokens: 8_210_340, costCents: 9_440, pct: 27 },
  { workspace: "design", calls: 4_120, tokens: 2_980_110, costCents: 3_660, pct: 10 },
  { workspace: "sandbox", calls: 3_226, tokens: 1_985_890, costCents: 2_100, pct: 6 },
  { workspace: "analytics", calls: 2_009, tokens: 999_000, costCents: 1_800, pct: 5 },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PreviewPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
      Preview — not yet wired to live data
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-bold tabular-nums">{value}</CardTitle>
      </CardHeader>
      {sub ? (
        <CardPanel className="pt-0">
          <p className="text-xs text-muted-foreground">{sub}</p>
        </CardPanel>
      ) : null}
    </Card>
  );
}

function PeriodSummaryCard() {
  const usedPct = Math.min(100, Math.round((TOTAL_SPENT_CENTS / INCLUDED_CENTS) * 100));
  const overIncluded = TOTAL_SPENT_CENTS > INCLUDED_CENTS;

  return (
    <Panel title="Current period">
      <p className="mb-4 text-sm text-muted-foreground">June 1 – June 30, 2026</p>
      <div className="flex items-end justify-between mb-3">
          <div>
            <span className="text-3xl font-bold tabular-nums">{formatCents(TOTAL_SPENT_CENTS)}</span>
            <span className="ml-2 text-sm text-muted-foreground">of {formatCents(INCLUDED_CENTS)} included</span>
          </div>
          {overIncluded ? (
            <Badge variant="warning" size="sm">Over quota</Badge>
          ) : (
            <Badge variant="success" size="sm">{usedPct}% used</Badge>
          )}
        </div>

        {/* Progress bar */}
        <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.min(100, usedPct)}%` }}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm">
          <div>
            <p className="text-muted-foreground">Projected month-end</p>
            <p className="font-semibold tabular-nums">{formatCents(PROJECTED_CENTS)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Daily average</p>
            <p className="font-semibold tabular-nums">{formatCents(Math.round(TOTAL_SPENT_CENTS / 29))}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Credits used</p>
            <p className="font-semibold tabular-nums">{(TOTAL_SPENT_CENTS).toLocaleString()} cr</p>
          </div>
          <div>
            <p className="text-muted-foreground">Credits remaining</p>
            <p className="font-semibold tabular-nums">{Math.max(0, INCLUDED_CENTS - TOTAL_SPENT_CENTS).toLocaleString()} cr</p>
          </div>
        </div>
    </Panel>
  );
}

function CreditBurnChart() {
  return (
    <Panel title="Credit burn — last 30 days">
      <p className="mb-4 text-sm text-muted-foreground">Daily credit spend (1 credit = $0.01)</p>
      <div style={{ height: 220 }}>
          <AreaChart
            data={BURN_DATA}
            height={220}
            xAxis={
              <LinearXAxis
                type="time"
                tickSeries={
                  <LinearXAxisTickSeries
                    label={
                      <LinearXAxisTickLabel
                        format={(d: Date) =>
                          d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
                        }
                        rotation={-30}
                      />
                    }
                    interval={5}
                  />
                }
              />
            }
            yAxis={
              <LinearYAxis
                tickSeries={
                  <LinearYAxisTickSeries
                    label={null}
                  />
                }
              />
            }
            series={
              <AreaSeries
                interpolation="smooth"
                colorScheme={["var(--chart-1)"]}
                animated
              />
            }
            gridlines={<GridlineSeries />}
          />
        </div>
    </Panel>
  );
}

function TokenSummaryCard() {
  return (
    <Panel title="Token usage">
      <p className="mb-4 text-sm text-muted-foreground">Input / output tokens this period</p>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Input</span>
            <span className="text-xl font-bold tabular-nums">{(INPUT_TOKENS / 1_000_000).toFixed(1)}M</span>
            <span className="text-xs text-muted-foreground">{formatCents(INPUT_COST_CENTS)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Output</span>
            <span className="text-xl font-bold tabular-nums">{(OUTPUT_TOKENS / 1_000_000).toFixed(1)}M</span>
            <span className="text-xs text-muted-foreground">{formatCents(OUTPUT_COST_CENTS)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total</span>
            <span className="text-xl font-bold tabular-nums">{(TOTAL_TOKENS / 1_000_000).toFixed(1)}M</span>
            <span className="text-xs text-muted-foreground">{formatCents(TOKEN_COST_CENTS)}</span>
          </div>
        </div>

        {/* Input vs output stacked bar */}
        <div className="mt-4 h-2 w-full rounded-full bg-muted overflow-hidden flex">
          <div
            className="h-full bg-primary/70"
            style={{ width: `${Math.round((INPUT_TOKENS / TOTAL_TOKENS) * 100)}%` }}
          />
          <div className="h-full bg-primary flex-1" />
        </div>
        <div className="mt-1 flex gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary/70" />
            Input {Math.round((INPUT_TOKENS / TOTAL_TOKENS) * 100)}%
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
            Output {Math.round((OUTPUT_TOKENS / TOTAL_TOKENS) * 100)}%
          </span>
        </div>
    </Panel>
  );
}

function ModelBreakdownTable() {
  const totalCost = MODEL_ROWS.reduce((s, r) => s + r.costCents, 0);

  return (
    <Panel title="Per-model breakdown">
      <p className="mb-4 text-sm text-muted-foreground">AI model calls, tokens, and credit cost this period</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase tracking-wide">
                <th className="pb-2 pr-4 font-medium">Model</th>
                <th className="pb-2 pr-4 font-medium text-right">Calls</th>
                <th className="pb-2 pr-4 font-medium text-right">Input tokens</th>
                <th className="pb-2 pr-4 font-medium text-right">Output tokens</th>
                <th className="pb-2 font-medium text-right">Credits</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {MODEL_ROWS.map((row) => (
                <tr key={row.model} className="text-sm">
                  <td className="py-3 pr-4">
                    <div className="font-medium">{row.model}</div>
                    <div className="text-xs text-muted-foreground">{row.provider}</div>
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">{row.calls.toLocaleString()}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                    {(row.inputTokens / 1_000_000).toFixed(2)}M
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                    {(row.outputTokens / 1_000_000).toFixed(2)}M
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    <div className="font-medium">{formatCents(Math.round(row.costCents))}</div>
                    <div className="text-xs text-muted-foreground">
                      {Math.round((row.costCents / totalCost) * 100)}%
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border text-sm font-semibold">
                <td className="pt-3 pr-4">Total</td>
                <td className="pt-3 pr-4 text-right tabular-nums">
                  {MODEL_ROWS.reduce((s, r) => s + r.calls, 0).toLocaleString()}
                </td>
                <td className="pt-3 pr-4 text-right tabular-nums text-muted-foreground">
                  {(INPUT_TOKENS / 1_000_000).toFixed(2)}M
                </td>
                <td className="pt-3 pr-4 text-right tabular-nums text-muted-foreground">
                  {(OUTPUT_TOKENS / 1_000_000).toFixed(2)}M
                </td>
                <td className="pt-3 text-right tabular-nums">{formatCents(Math.round(totalCost))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
    </Panel>
  );
}

function CapabilityTable() {
  const totalCost = CAPABILITY_ROWS.reduce((s, r) => s + r.costCents, 0);

  return (
    <Panel title="Per-capability usage">
      <p className="mb-4 text-sm text-muted-foreground">API and MCP capability call volume and cost</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase tracking-wide">
                <th className="pb-2 pr-4 font-medium">Capability</th>
                <th className="pb-2 pr-4 font-medium">Category</th>
                <th className="pb-2 pr-4 font-medium text-right">Calls</th>
                <th className="pb-2 font-medium text-right">Credits</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {CAPABILITY_ROWS.sort((a, b) => b.costCents - a.costCents).map((row) => (
                <tr key={row.capability}>
                  <td className="py-3 pr-4 font-mono text-xs">{row.capability}</td>
                  <td className="py-3 pr-4">
                    <Badge variant="outline" size="sm">{row.category}</Badge>
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">{row.calls.toLocaleString()}</td>
                  <td className="py-3 text-right tabular-nums">
                    <div className="font-medium">{formatCents(row.costCents)}</div>
                    <div className="text-xs text-muted-foreground">
                      {Math.round((row.costCents / totalCost) * 100)}%
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </Panel>
  );
}

function WorkspaceTable() {
  return (
    <Panel title="Per-workspace usage">
      <p className="mb-4 text-sm text-muted-foreground">Credit spend split across workspaces this period</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase tracking-wide">
                <th className="pb-2 pr-4 font-medium">Workspace</th>
                <th className="pb-2 pr-4 font-medium text-right">Calls</th>
                <th className="pb-2 pr-4 font-medium text-right">Tokens</th>
                <th className="pb-2 pr-4 font-medium text-right">Credits</th>
                <th className="pb-2 font-medium text-right">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {WORKSPACE_ROWS.map((row) => (
                <tr key={row.workspace}>
                  <td className="py-3 pr-4 font-medium">{row.workspace}</td>
                  <td className="py-3 pr-4 text-right tabular-nums">{row.calls.toLocaleString()}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                    {(row.tokens / 1_000_000).toFixed(2)}M
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">{formatCents(row.costCents)}</td>
                  <td className="py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${row.pct}%` }}
                        />
                      </div>
                      <span className="tabular-nums text-muted-foreground">{row.pct}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function UsageDashboard() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <div className="flex justify-end">
        <PreviewPill />
      </div>

      {/* Top KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Credits spent"
          value={formatCents(TOTAL_SPENT_CENTS)}
          sub="this billing period"
        />
        <StatCard
          label="Total tokens"
          value={`${(TOTAL_TOKENS / 1_000_000).toFixed(1)}M`}
          sub={`${(INPUT_TOKENS / 1_000_000).toFixed(1)}M in · ${(OUTPUT_TOKENS / 1_000_000).toFixed(1)}M out`}
        />
        <StatCard
          label="API + MCP calls"
          value={CAPABILITY_ROWS.reduce((s, r) => s + r.calls, 0).toLocaleString()}
          sub="across all capabilities"
        />
        <StatCard
          label="Active workspaces"
          value={WORKSPACE_ROWS.length.toString()}
          sub="with usage this period"
        />
      </div>

      {/* Current period summary + burn chart */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <PeriodSummaryCard />
        </div>
        <div className="lg:col-span-2">
          <CreditBurnChart />
        </div>
      </div>

      {/* Token summary */}
      <TokenSummaryCard />

      {/* Model breakdown */}
      <ModelBreakdownTable />

      {/* Capability table */}
      <CapabilityTable />

      {/* Workspace split */}
      <WorkspaceTable />
    </div>
  );
}
