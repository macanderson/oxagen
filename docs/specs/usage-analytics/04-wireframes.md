# 04 — Wireframes

Low-fidelity, line-drawn. The rendered, styled version is `mockup.html` (published as an
Artifact). Component names in **bold** map to real files (existing) or proposed new files.

> Visual-reference note: the user's "a stat box like this" image did not reach the author as
> viewable content. The **UsageStatCard** below is designed from the text description
> (label · big value · delta · sparkline · drill-in). Confirm against the reference before build.

## 1. The canonical `UsageStatCard`

The atom every surface shares. Built on `@oxagen/ui` `Card` + the `_overview/hud` primitives
(`StatCard`, `Sparkline`, `MiniBars`, `DeltaChip`) — unified into one exported component
`apps/app/src/components/usage/usage-stat-card.tsx`.

```
┌───────────────────────────────────────┐
│  ⚡ Executions              ⌄ (drill) │   ← label + icon; whole card is a Link (href → filter)
│                                        │
│   12,480          ▲ 18%   vs last mo   │   ← big value  ·  DeltaChip (green ▲ / red ▼ / grey "new")
│                                        │
│   ▁▂▃▅▆▇▆▅▃▂▁ ▁▂▃  (sparkline, 30d)   │   ← inline SVG Sparkline / MiniBars, server-safe
│                                        │
│   1,204 today · $342.10 cost           │   ← optional sub-line (secondary metric / cost)
└───────────────────────────────────────┘
```

Props (superset of existing `StatCardProps`): `label`, `value`, `icon`, `delta {current,
previous, goodDirection}`, `sparkline number[]`, `sub`, `href`, `tone`, `loading`, `notFilterable?`
(renders the muted "not filterable by X" chip from the applicability matrix), `costHidden?`
(hide the cost sub-line for non-billing-managers).

States: **loading** (skeleton), **empty** ("— · no activity"), **degraded** ("— · metering
unavailable"), **filtered-out** (40% opacity + overlay).

## 2. Org dashboard — `/{org-slug}/dashboard` (Overview tab)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Acme  ›  Dashboard                                          [Overview] Usage  │  ← PageTabs
├──────────────────────────────────────────────────────────────────────────────┤
│  UsageFilterBar:  [ This month ⌄ ]  [ All workspaces ⌄ ] [ All users ⌄ ]       │
│                   [ Model ⌄ ] [ Provider ⌄ ] [ Surface ⌄ ]  ·  agent/repo/env  │
│                                                              (disabled·soon)   │
├──────────────────────────────────────────────────────────────────────────────┤
│  CORE STAT STRIP  (UsageStatCard × grid, StatGroup columns=4)                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
│  │ Executions │ │ Chat turns │ │Total tokens│ │   Cost     │                   │
│  │  12,480 ▲  │ │  8,932  ▲  │ │  47.2M  ▲  │ │ $2,318 ▲   │                   │
│  │ ▁▂▃▅▆▇     │ │ ▂▃▅▆▇▆     │ │ ▃▅▆▇▆▅     │ │ ▁▃▅▆▇      │                   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘                   │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
│  │ Tokens in  │ │ Tokens out │ │ Cache-read │ │ PRs·Commits│                   │
│  │  31.9M     │ │  15.3M     │ │  64% share │ │  84 · 512  │                   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘                   │
├──────────────────────────────────────────────────────────────────────────────┤
│  CAPABILITY-PACK STRIP  (dynamic — distinct capability_name)                   │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
│  │ Documents  │ │  Images    │ │  Videos    │ │  + others  │  ← families from  │
│  │   1,204    │ │   3,908    │ │    212     │ │  (svg,pdf) │    display map,    │
│  │ generated  │ │ generated  │ │ generated  │ │            │    data=distinct  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘                   │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────┐  ┌──────────────────────────────────┐        │
│  │ Daily usage (StackedBar)    │  │ Top models (BarList)             │        │  ← reaviz,
│  │  cost ⇄ tokens toggle       │  │  fable-5 ▇▇▇▇▇  gpt ▇▇▇  …        │        │    ssr:false
│  │  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇          │  │                                   │        │
│  └─────────────────────────────┘  └──────────────────────────────────┘        │
├──────────────────────────────────────────────────────────────────────────────┤
│  ACTIVITY TILES  (each independent Suspense, fail-open, per-store)             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
│  │ Agent runs   │ │ Memories     │ │ Graph nodes  │ │ Automations  │          │
│  │  1,043       │ │  318 created │ │ +2.1k −140   │ │  47 created  │          │
│  │ (agent_exec) │ │  (Neo4j)     │ │ (graph.stats)│ │ (playbooks)  │          │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘          │
└──────────────────────────────────────────────────────────────────────────────┘
```

The **Usage tab** (`/{org}/dashboard/usage`) is the existing `billing/usage` deep view: range
picker + `UsageBreakdownView` (by-model / by-surface / by-workspace / **by-user** tables with
CSV export), reused verbatim, now with the `byUser` column and the shared filter bar.

## 3. User Usage tab — `/account/usage`

Same atoms, cross-org, fed by `get_my_usage`. The distinguishing element is the **Org** selector
(defaults "All orgs") and a **by-org** breakdown at the bottom.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Account  ›  Usage                                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  [ This month ⌄ ]  [ All orgs ⌄ ]  [ Workspace: Platform ⌄ ]  [ Model ⌄ ] …   │
│  (workspace defaults to your last-active; org defaults to All)                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  YOUR FOOTPRINT (this month, across all orgs)                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │
│  │Executions│ │Chat turns│ │  Tokens  │ │ Memories │ │  Files   │ │ PRs·Cmt │ │
│  │  1,204   │ │   832    │ │  4.1M    │ │   58     │ │  412     │ │ 12 · 88 │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └─────────┘ │
│  (+ Images / Videos generated · Nodes+Edges C/U/D · Automations created)      │
├──────────────────────────────────────────────────────────────────────────────┤
│  BY ORG (your activity per org you belong to — only orgs with activity shown)  │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │ Acme      ▇▇▇▇▇▇▇▇▇▇  842 exec · 3.0M tok · $210                        │   │
│  │ Beta Inc  ▇▇▇        362 exec · 1.1M tok · $74                          │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────────────┤
│  BY MODEL · BY SURFACE · BY WORKSPACE · BY REPO* · BY ENVIRONMENT* · BY AGENT* │
│  (*disabled until Phase 3 enrichment — shown greyed with "coming soon")        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Security reminder rendered as a footnote: *"Shows only your own activity."* (The contract's
`WHERE user_id = session` guard is what makes that true — §02 §2.2.)

## 4. Workspace overview — enhancement diff

Existing tiles stay; the diff is the **unified strip** + the new stats + a "vs org" delta.

```
BEFORE (MeteringKpiStrip):   [Spend MTD] [Tokens] [Agent runs] [Credit balance]

AFTER (UsageStatCard strip): [Executions] [Chat turns] [Tokens in/out] [Cost]
                             [Cache-read share] [PRs·Commits] [Generated: 412] [Credit bal.]
                             each with a small "· 34% of org" context line
```

`GraphHero`, `MemoriesPanel`, `AutomationsPanel`, `UsagePanel` charts are unchanged (already
present); they gain the shared filter bar (workspace-scoped) for consistency.

## 5. "Sexy" — the visual language (for `mockup.html` and the build)

- **Big numbers, quiet chrome.** The value is the loudest element; labels are muted uppercase
  tracking; borders are hairlines. (Matches the existing `Stat`/HUD aesthetic.)
- **One accent for delta only.** Green up / red down / grey "new" — the *only* saturated color in
  the strip, so the eye lands on change. Everything else is neutral + the CVD-safe dataviz
  palette already used in `usage-charts.tsx`.
- **Sparklines everywhere, gridlines nowhere.** Every KPI carries a 30-point trend; charts use
  the existing reaviz theme with minimal axes.
- **Density with air.** `StatGroup columns={4}` hairline grid; generous padding; the strip reads
  in one glance, the tables reward a lean-in.
- **Dark/light parity** via the existing `useDarkMode()` hook the reaviz modules already use.
- **Motion is restraint.** Numbers count-up once on mount (respecting `prefers-reduced-motion`);
  no looping animation.
