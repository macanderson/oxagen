// @vitest-environment jsdom
// The Cost tab (pages/run.md, Model fit and Cost; run.audit-prompt.md checks
// 4, 10 and 11): Model fit first, then the six instruments, Spend by area,
// Tool calls, the waterfall, and Spend by token class beside Prompt
// composition, every figure read from the page's one derivation.
//
// The tab is rendered over `runMetrics` of a scripted run shaped like the
// mockup's release run (`cost.builders.ts`), and over the `get_run_turns` read
// of the same script (`costTurns`), so the tests read figures the way the page
// derives them: the reconciliation tests hold the Tokens instrument,
// the total row of Spend by token class and the stat row to one number, and
// the waterfall's total row to the Shape of the run instrument. The negative
// tests hold every panel to "not recorded" where the record carries nothing.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "@/data/contracts/agents";
import type {
  RunCost,
  RunFindings,
  RunTranscript,
  RunTurns,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { SpendFindingEvidence } from "@/data/contracts/spend";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  costRollup,
  costTranscript,
  costTurns,
  RELEASE_RUN_CLASSES,
  releaseRunCost,
  releaseRunTurns,
} from "./cost.builders";
import { runMetrics } from "./metrics";
import { NOW, runDetail, runOutputs, runRow, runSource } from "./run.builders";
import type { RunTabProps } from "./tab-props";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/acme/core-platform/runs/tse_7k2m9q",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
}));
vi.mock("./fit-actions", () => ({ openFitChange: vi.fn() }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { CostTab } = await import("./cost");
const { StatRow } = await import("./stats");

afterEach(cleanup);

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** The mockup's release run: live, at the gateway, on the top class of its family. */
const RELEASE_RUN = runRow({
  status: "live",
  outcome: "running",
  sealedAt: null,
  startedAt: new Date(NOW - 780_000).toISOString(),
  turns: 7,
  steps: 24,
  frames: 70,
  cost: { micros: "4130000", currency: "USD", basis: "gateway_observed" },
  model: { slug: "claude-opus-5", provider: "anthropic", tier: "opus" },
  enforcementTier: "gateway",
});

function agent(overrides: Partial<AgentDetail> = {}): Read<AgentDetail> {
  return readOk({
    identity: {
      id: "agt_releasemgr",
      slug: "release-manager",
      name: "Release manager",
      description: null,
      agentKey: "acme.core.release-manager",
      harness: "claude-code",
      principalId: null,
      operatorId: null,
      status: "enrolled",
      registeredAt: "2026-09-01T10:00:00.000Z",
      firstFrameAt: null,
      costCenter: null,
    },
    credentials: [],
    roles: [],
    hosts: [],
    definition: null,
    ...overrides,
  });
}

function props({
  run = RELEASE_RUN,
  cost = readOk(releaseRunCost()),
  transcript = readOk(costTranscript(releaseRunTurns())),
  turns = readOk(costTurns(releaseRunTurns())),
  agentRead = null,
  findings,
  findingEvidence,
  finding = null,
}: {
  run?: RunRow;
  cost?: Read<RunCost>;
  transcript?: Read<RunTranscript>;
  /** The tab's own `get_run_turns` read. */
  turns?: Read<RunTurns>;
  agentRead?: Read<AgentDetail> | null;
  /** The tab's own `list_findings` read; a run no finding cites when absent. */
  findings?: Read<RunFindings>;
  /** The evidence `?finding=` opens. */
  findingEvidence?: Read<SpendFindingEvidence>;
  /** `?finding=`. */
  finding?: string | null;
} = {}): RunTabProps {
  const detail = runDetail({ run });
  const { source } = runSource({
    detail: readOk(detail),
    turns,
    ...(findings === undefined ? {} : { findings }),
    ...(findingEvidence === undefined ? {} : { findingEvidence }),
  });
  return {
    ctx,
    source,
    run,
    detail,
    place: { org: "acme", ws: "core-platform", runId: run.id },
    view: { kinds: [], frames: null, body: null, finding },
    metrics: runMetrics({ run, cost, transcript }),
    transcript,
    everything: transcript,
    cost,
    outputs: readOk(runOutputs()),
    work: Promise.resolve(readError("not_found", 404)),
    issues: Promise.resolve(readError("not_found", 404)),
    agent: agentRead,
    now: NOW,
  };
}

async function renderTab(tab: RunTabProps, { withStats = false } = {}) {
  const body = await CostTab(tab);
  return render(
    <IntlProvider>
      {withStats ? <StatRow run={tab.run} metrics={tab.metrics} /> : null}
      {body}
    </IntlProvider>,
  );
}

/** The digits of a formatted count: "768,981" is 768981. */
function digits(text: string | null | undefined): number {
  const match = /\d[\d,]*/.exec(text ?? "");
  if (match === null) throw new Error(`no count in ${String(text)}`);
  return Number(match[0].replaceAll(",", ""));
}

describe("CostTab", () => {
  it("draws Model fit, the instruments, Spend by area, Tool calls, the waterfall and the two tables, in that order", async () => {
    const { container } = await renderTab(props());
    const order = [
      "model-fit",
      "run-instruments",
      "spend-by-area",
      "tool-calls",
      "waterfall-panel",
      "token-classes",
      "prompt-composition",
    ].map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      const before = order[i - 1];
      const after = order[i];
      if (before === undefined || after === undefined)
        throw new Error("every panel is drawn");
      expect(
        before.compareDocumentPosition(after) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    for (const heading of [
      "Model fit",
      "Spend by area",
      "Tool calls",
      "Waterfall",
      "Spend by token class",
      "Prompt composition",
    ])
      expect(
        screen.getByRole("heading", { level: 3, name: heading }),
      ).toBeTruthy();
    const instruments = screen.getByRole("region", { name: "Run instruments" });
    expect(
      within(instruments)
        .getAllByRole("heading", { level: 4 })
        .map((h) => h.textContent),
    ).toEqual([
      "Cost so far",
      "Wall clock",
      "Tokens",
      "Shape of the run",
      "Tool calls",
      "Productive ratio",
    ]);
    await expectNoAxe(container);
  });

  it("holds the Tokens instrument, the token class total and the stat row to one total", async () => {
    await renderTab(props(), { withStats: true });
    const instrument = digits(
      screen.getByTestId("inst-tokens-value").textContent,
    );
    const total = digits(
      screen.getByTestId("token-class-total-tokens").textContent,
    );
    const stat = digits(
      within(screen.getByTestId("run-stat-tokens")).getByText(/^\d[\d,]*$/)
        .textContent,
    );
    expect(instrument).toBe(768_981);
    expect(total).toBe(instrument);
    expect(stat).toBe(instrument);
    // The rows under the total add up to it.
    const rows = screen.getAllByTestId("token-class-row");
    const sum = (classes: readonly string[]) =>
      rows
        .filter((row) => classes.includes(row.dataset.class ?? ""))
        .reduce((acc, row) => acc + digits(row.children[1]?.textContent), 0);
    const input = sum([
      "input_uncached",
      "cache_read",
      "cache_write_5m",
      "cache_write_1h",
    ]);
    const output = sum(["output", "reasoning"]);
    expect(input + output).toBe(total);
    // "N in, N out" on the stat row and the instrument is those two sums.
    const inOut = screen.getByTestId("inst-tokens").textContent;
    expect(inOut).toContain("732,270 in · 36,711 out");
    expect(input).toBe(732_270);
    expect(output).toBe(36_711);
    expect(screen.getByTestId("run-stat-tokens")).toHaveTextContent(
      "732,270 in, 36,711 out",
    );
  });

  it("totals the waterfall from its rows and agrees with the Shape of the run instrument", async () => {
    await renderTab(props());
    const rows = screen.getAllByTestId("waterfall-row");
    expect(rows).toHaveLength(7);
    expect(screen.getAllByTestId("waterfall-bar")).toHaveLength(7);
    const column = (index: number) =>
      rows.reduce(
        (acc, row) => acc + digits(row.children[index]?.textContent),
        0,
      );
    const total = screen.getByTestId("waterfall-total");
    const steps = digits(total.children[1]?.textContent);
    const frames = digits(total.children[2]?.textContent);
    expect(steps).toBe(column(1));
    expect(frames).toBe(column(2));
    const shape = screen.getByTestId("inst-shape-value").textContent;
    expect(shape).toContain(`${String(steps)}steps`);
    expect(shape).toContain(`${String(frames)}frames`);
    expect(shape).toContain("7turns");
    // The cost column adds up to the total row, set against the recorded cost.
    expect(total).toHaveTextContent("$4.13");
    expect(total).toHaveTextContent("of $4.13 recorded");
    expect(rows[0]).toHaveTextContent("$0.00 → $0.41");
    expect(rows[6]).toHaveTextContent("$3.58 → $4.13");
    // Turn 5 is the dearest, on the chart and on the Cost so far instrument.
    expect(screen.getByTestId("inst-cost")).toHaveTextContent(
      "turn 5 was the dearest",
    );
    expect(screen.getByTestId("inst-cost")).toHaveTextContent("$0.59 per turn");
  });

  it("counts the tool calls by family and by batch from the transcript", async () => {
    await renderTab(props());
    const panel = screen.getByTestId("tool-calls");
    expect(panel).toHaveTextContent("14 calls · 9 batches · 5 families");
    const families = screen.getAllByTestId("family-row");
    expect(families.map((row) => row.children[1]?.textContent)).toEqual([
      "5",
      "3",
      "2",
      "2",
      "2",
    ]);
    expect(families[0]).toHaveTextContent("File read");
    const shell = families.find((row) => row.textContent.includes("Shell"));
    expect(shell?.children[5]).toHaveTextContent("1");
    expect(panel).toHaveTextContent("9 · 4 ran more than one tool");
    expect(panel).toHaveTextContent("3 tools at once");
    expect(panel).toHaveTextContent("14 calls over 9 batches");
    expect(screen.getByTestId("inst-calls")).toHaveTextContent("1 failed");
  });

  // The reading is Oxagen's, stored on the run after the seal (ADR-194); the
  // tab draws it and computes nothing. model-fit.test.tsx holds each card.
  it("draws the stored Model fit reading of a sealed run, and the effort the record holds", async () => {
    const run = runRow({
      ...RELEASE_RUN,
      status: "sealed",
      outcome: "completed",
      sealedAt: new Date(NOW).toISOString(),
      effort: "high",
      effortSource: "request",
      fit: {
        method: "run-fit/v1",
        readAt: new Date(NOW).toISOString(),
        sealedAt: new Date(NOW).toISOString(),
        read: {
          prompts: 2,
          turns: 7,
          steps: 24,
          failed: 1,
          outputTokens: 12_000,
          reasoningTokens: 900,
        },
        model: { verdict: "fit", tier: "opus" },
        effort: { verdict: "fit", effort: "high", source: "request" },
      },
    });
    await renderTab(props({ run, agentRead: agent() }));
    expect(screen.getByTestId("model-fit")).toHaveTextContent(
      "generated · not the record",
    );
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "The opus class matches this shape of work.",
    );
    expect(screen.getByTestId("fit-effort-card")).toHaveTextContent(
      "Effort high, read from the model request, fits this run.",
    );
    expect(screen.queryByTestId("fit-change-model")).toBeNull();
    const read = screen.getByTestId("fit-read");
    expect(read).toHaveTextContent(
      "2 prompts · 7 turns · 24 steps · 1 tool call failed",
    );
    expect(read).toHaveTextContent(".oxagen/agents/release-manager.toml");
  });

  it("draws no reading for a live run, and says the gateway run's request carried no effort (negative)", async () => {
    await renderTab(props());
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "The run is still open. Oxagen reads it once it seals.",
    );
    expect(screen.getByTestId("fit-effort-card")).toHaveTextContent(
      "This agent sent no effort setting, so the model used its own default.",
    );
    expect(screen.getByTestId("fit-read")).toHaveTextContent(
      "There is no reading for this run.",
    );
    expect(screen.queryByTestId("fit-change-model")).toBeNull();
  });

  it("says not recorded wherever the record carries nothing, and never prints a figure for it (negative)", async () => {
    await renderTab(props());
    const areas = screen.getAllByTestId("area-row");
    expect(areas.map((row) => row.dataset.area)).toEqual([
      "initial",
      "followUp",
      "context",
      "definitions",
      "results",
      "system",
      "output",
    ]);
    for (const row of areas.slice(0, 6)) {
      expect(row).toHaveTextContent("not recorded");
      expect(row.textContent).not.toMatch(/\$|\d/);
    }
    // Model output is recorded: 36,711 tokens, for which the rollup recorded
    // $1.514138 of output and $0.763218 of reasoning.
    expect(areas[6]).toHaveTextContent("36,711 tok");
    expect(areas[6]).toHaveTextContent("$2.28");
    for (const tool of screen.getAllByTestId("dearest-tool"))
      expect(tool).toHaveTextContent("not recorded");
    const prefetch = screen.getByTestId("prefetch-figure");
    expect(prefetch).toHaveTextContent("not recorded");
    for (const part of screen.getAllByTestId("composition-part")) {
      expect(part).toHaveTextContent("not recorded");
      expect(part.textContent).not.toMatch(/\d/);
    }
    // No finding cites the run: no turn is pinned, and no cell claims one is.
    expect(screen.queryByTestId("waterfall-pin")).toBeNull();
    for (const row of screen.getAllByTestId("waterfall-row"))
      expect(row.lastElementChild?.textContent).toBe("");
    expect(screen.getByTestId("inst-cost")).toHaveTextContent(
      "this agent's median run is not recorded",
    );
    expect(screen.getByTestId("inst-ratio")).toHaveTextContent(
      "this agent's 30-day ratio is not recorded",
    );
  });

  it("shows each class's recorded cost, which sum to the run's recorded cost, and says they are recorded", async () => {
    await renderTab(props());
    const composition = screen.getByTestId("prompt-composition");
    // Input: $1.244860 recorded for uncached input plus $0.607784 for cache
    // reads is $1.852644 over 732,270 tokens, $2.530001 a million.
    expect(composition).toHaveTextContent(
      "$2.53 per million across all input classes",
    );
    expect(screen.getByTestId("inst-tokens")).toHaveTextContent(
      "effective input price $2.53 per million",
    );
    expect(composition).toHaveTextContent("0% · nothing written this run");
    expect(composition).toHaveTextContent(
      "gateway_observed · counted by the proxy from the bytes that passed through it",
    );
    expect(composition).toHaveTextContent("71% of steps advanced the task");
    // Each row is the class the rollup recorded, to the micro.
    const row = (tokenClass: string) =>
      screen
        .getAllByTestId("token-class-row")
        .find((each) => each.dataset.class === tokenClass);
    expect(row("input_uncached")?.children[2]).toHaveTextContent("$1.24486");
    expect(row("cache_read")?.children[2]).toHaveTextContent("$0.607784");
    expect(row("output")?.children[2]).toHaveTextContent("$1.514138");
    expect(row("reasoning")?.children[2]).toHaveTextContent("$0.763218");
    // The rows sum to the rollup's cost: the page adds, it does not price.
    const total = screen.getByTestId("token-class-total");
    expect(total).toHaveTextContent("$4.13");
    expect(total).toHaveTextContent("100%");
    const note = screen.getByTestId("token-class-note");
    expect(note).toHaveTextContent(
      "These are the run's recorded costs. Each call was priced at the rate in force when it was made, so a later price change does not move them.",
    );
    expect(note).toHaveTextContent(
      "The run recorded $4.13 gateway_observed. It was priced with prc_01k4qj9e.",
    );
    expect(note).not.toHaveTextContent("price book");
  });

  it("shows no class cost when the rollup names no model, and says why (negative)", async () => {
    const rollup = releaseRunCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    await renderTab(
      props({ cost: readOk({ rollup: { ...rollup, byModel: [] } }) }),
    );
    for (const row of screen.getAllByTestId("token-class-row"))
      expect(row.children[2]).toHaveTextContent("not recorded");
    expect(screen.getByTestId("token-class-total")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.getByTestId("token-class-note")).toHaveTextContent(
      "The rollup recorded no model for this run, so no class has a cost.",
    );
    expect(screen.getByTestId("inst-tokens")).toHaveTextContent(
      "effective input price not recorded",
    );
    // The token counts are the rollup's totals, so they stand without a model row.
    expect(screen.getByTestId("token-class-total-tokens")).toHaveTextContent(
      "768,981",
    );
  });

  it("says the cache's saving is not recorded on a row rolled up before savings were, never a zero (negative)", async () => {
    await renderTab(
      props({
        cost: readOk(
          costRollup({
            micros: "4130000",
            tokens: {
              inputUncached: 124_486,
              cacheRead: 607_784,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              output: 24_229,
              reasoning: 12_482,
            },
            byClass: RELEASE_RUN_CLASSES,
            cacheSaving: null,
            cacheHitRate: 0.83,
            modelCalls: 10,
          }),
        ),
      }),
      { withStats: true },
    );
    const tile = screen.getByTestId("inst-cost");
    expect(tile).toHaveTextContent("cache hit 83% · saving not recorded");
    expect(tile).not.toHaveTextContent("saved about");
    const stat = screen.getByTestId("run-stat-cache");
    expect(stat).toHaveTextContent("saving not recorded");
    expect(stat).not.toHaveTextContent("$0.00");
    // The class split was recorded, so it stands.
    expect(screen.getByTestId("token-class-total")).toHaveTextContent("$4.13");
  });

  it("claims neither a saving nor a missing one for a run that read nothing from the cache (negative)", async () => {
    // The rollup records a zero saving for a model that read nothing, and
    // `runMetrics` claims no saving over it, so `cacheSaved` is null here
    // exactly as on a legacy row. Only the cache-read count tells them apart.
    await renderTab(
      props({
        cost: readOk(
          costRollup({
            micros: "4130000",
            tokens: {
              inputUncached: 732_270,
              cacheRead: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              output: 24_229,
              reasoning: 12_482,
            },
            byClass: { ...RELEASE_RUN_CLASSES, cacheRead: "0" },
            cacheSaving: "0",
            cacheHitRate: 0,
            modelCalls: 10,
          }),
        ),
      }),
      { withStats: true },
    );
    const tile = screen.getByTestId("inst-cost");
    expect(tile).toHaveTextContent("cache hit 0%");
    expect(tile).not.toHaveTextContent("saving not recorded");
    expect(tile).not.toHaveTextContent("saved about");
    const stat = screen.getByTestId("run-stat-cache");
    expect(stat).toHaveTextContent("0%");
    expect(stat).not.toHaveTextContent("saving not recorded");
    expect(stat).not.toHaveTextContent("saved about");
  });

  it("shows the recorded saving on the instrument and the stat row", async () => {
    await renderTab(props(), { withStats: true });
    // 607,784 cache reads, recorded as saving $5.470056.
    expect(screen.getByTestId("inst-cost")).toHaveTextContent(
      "cache hit 83% · saved about $5.47 against an uncached prompt",
    );
    expect(screen.getByTestId("run-stat-cache")).toHaveTextContent(
      "saved about $5.47",
    );
  });

  it("says the costs cover only the priced calls when the rollup could not price some", async () => {
    const rollup = releaseRunCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    await renderTab(
      props({
        cost: readOk({
          rollup: {
            ...rollup,
            byModel: rollup.byModel.map((row) => ({
              ...row,
              hasUnpriced: true,
            })),
          },
        }),
      }),
    );
    const note = screen.getByTestId("token-class-note");
    expect(note).toHaveTextContent(
      "The rollup could not price some of this run's calls, so each cost covers only the calls it priced.",
    );
    expect(note).not.toHaveTextContent("These are the run's recorded costs.");
    // What was recorded still shows.
    expect(screen.getByTestId("token-class-total")).toHaveTextContent("$4.13");
  });

  it("says the rollup has not run rather than printing zeros (negative)", async () => {
    await renderTab(props({ cost: readOk({ rollup: null }) }));
    expect(screen.getByTestId("cost-not-rolled-up")).toHaveTextContent(
      "A zero here would be a measurement",
    );
    expect(screen.queryAllByTestId("token-class-row")).toHaveLength(0);
    expect(screen.getByTestId("inst-tokens-value")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.getByTestId("inst-ratio-value")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.getByTestId("area-note")).toHaveTextContent(
      "The rollup has not counted this run's tokens yet",
    );
    // The run row still carries its cost, with its basis.
    expect(screen.getByTestId("inst-cost")).toHaveTextContent("$4.13");
    expect(screen.getByTestId("inst-cost")).toHaveTextContent(
      "gateway_observed",
    );
  });

  it("prints a live wrapped run's reported spend by model, labelled provisional, before the rollup reaches it (#4032)", async () => {
    const reported = (micros: string) => ({
      micros,
      currency: "USD",
      basis: "client_attested" as const,
    });
    await renderTab(
      props({
        run: runRow({ ...RELEASE_RUN, cost: null }),
        cost: readOk({
          rollup: null,
          provisional: {
            byModel: [
              {
                model: "claude-haiku-5",
                provider: "anthropic",
                calls: 1,
                cost: reported("20000"),
              },
              {
                model: "claude-opus-5",
                provider: "anthropic",
                calls: 12,
                cost: reported("1200000"),
              },
            ],
            toolCalls: 9,
            asOf: new Date(NOW - 60_000).toISOString(),
          },
        }),
      }),
      { withStats: true },
    );
    const tile = screen.getByTestId("inst-cost");
    expect(screen.getByTestId("inst-cost-value")).toHaveTextContent("$1.22");
    expect(tile).toHaveTextContent("agent reported, provisional");
    // Dearest first, each with its calls.
    expect(screen.getByTestId("inst-cost-provisional")).toHaveTextContent(
      "claude-opus-5 $1.20 over 12 calls, claude-haiku-5 $0.02 over 1 call",
    );
    // The stat row prints the same figure under the same label.
    const stat = screen.getByTestId("run-stat-cost");
    expect(stat).toHaveTextContent("$1.22");
    expect(stat).toHaveTextContent("agent reported, provisional");
  });

  it("marks a provisional sum as a floor when a model reported no cost (negative)", async () => {
    await renderTab(
      props({
        run: runRow({ ...RELEASE_RUN, cost: null }),
        cost: readOk({
          rollup: null,
          provisional: {
            byModel: [
              {
                model: "local-llama",
                provider: null,
                calls: 4,
                cost: null,
              },
              {
                model: "claude-opus-5",
                provider: "anthropic",
                calls: 12,
                cost: {
                  micros: "1200000",
                  currency: "USD",
                  basis: "client_attested",
                },
              },
            ],
            toolCalls: 9,
            asOf: new Date(NOW - 60_000).toISOString(),
          },
        }),
      }),
      { withStats: true },
    );
    expect(screen.getByTestId("inst-cost-value")).toHaveTextContent("$1.20+");
    expect(screen.getByTestId("inst-cost-provisional")).toHaveTextContent(
      "local-llama over 4 calls, cost not reported",
    );
    expect(screen.getByTestId("run-stat-cost")).toHaveTextContent("$1.20+");
  });

  it("keeps the run row's cost when the cost read fails, names no basis it lacks, and claims no retry count (negative)", async () => {
    await renderTab(
      props({
        run: runRow({
          ...RELEASE_RUN,
          cost: { micros: "4130000", currency: "USD", basis: null },
        }),
        cost: readError("clickhouse_unreachable", 502),
      }),
    );
    const tile = screen.getByTestId("inst-cost");
    expect(tile).toHaveTextContent("$4.13");
    expect(tile).toHaveTextContent("basis not recorded");
    const ratio = screen.getByTestId("inst-ratio");
    expect(ratio).not.toHaveTextContent("The rollup recorded");
    expect(screen.getByTestId("inst-ratio-value")).toHaveTextContent(
      "not recorded",
    );
  });

  it("draws the cost tile as not recorded, with no per-turn figure and every column unpriced, when nothing carried a cost (negative)", async () => {
    const unpriced = releaseRunTurns().map((turn) => ({
      ...turn,
      steps: turn.steps.map((step) =>
        step.kind === "model" ? { ...step, micros: null } : step,
      ),
    }));
    await renderTab(
      props({
        run: runRow({ ...RELEASE_RUN, cost: null }),
        cost: readOk({ rollup: null }),
        transcript: readOk(costTranscript(unpriced)),
        turns: readOk(costTurns(unpriced)),
      }),
    );
    const tile = screen.getByTestId("inst-cost");
    expect(tile).toHaveTextContent("not recorded");
    expect(tile).not.toHaveTextContent("per turn");
    expect(tile).not.toHaveTextContent("was the dearest");
    expect(tile.textContent).not.toMatch(/\$/);
    const columns = screen.getAllByTestId("inst-cost-col");
    expect(columns).toHaveLength(7);
    for (const [index, column] of columns.entries()) {
      expect(column).toHaveAttribute(
        "title",
        `Turn ${String(index + 1)}: cost not recorded`,
      );
      // No bar is drawn for a turn with no cost to scale.
      expect(column.querySelector("i")).toBeNull();
    }
  });

  it("marks the last turn live only on a live run, never on a halted run with no seal (#3375)", async () => {
    await renderTab(props());
    expect(screen.getByTestId("inst-cost")).toHaveTextContent("turn 7 · live");
    cleanup();
    await renderTab(
      props({
        run: runRow({
          ...RELEASE_RUN,
          status: "halted",
          outcome: "cancelled",
          sealedAt: null,
        }),
      }),
    );
    for (const id of ["inst-cost", "inst-shape"]) {
      const tile = screen.getByTestId(id);
      expect(tile).toHaveTextContent("turn 7");
      expect(tile).not.toHaveTextContent("live");
    }
  });

  it("says the cache hit was not recorded, and leaves out the reasoning and per-call parts the rollup did not carry (negative)", async () => {
    await renderTab(
      props({
        cost: readOk(
          costRollup({
            micros: "4130000",
            tokens: {
              inputUncached: 124_486,
              cacheRead: 607_784,
              cacheWrite5m: 5_000,
              cacheWrite1h: 0,
              output: 24_229,
              reasoning: 0,
            },
            byClass: {
              ...RELEASE_RUN_CLASSES,
              cacheWrite5m: "31250",
              output: "2246106",
              reasoning: "0",
            },
            cacheSaving: "5470056",
            cacheHitRate: null,
            modelCalls: 0,
          }),
        ),
      }),
    );
    const tokens = screen.getByTestId("inst-tokens");
    expect(tokens).toHaveTextContent("cache hit not recorded");
    expect(tokens).not.toHaveTextContent("of the output was reasoning");
    expect(tokens).not.toHaveTextContent("tokens per model call");
    // The run wrote to the cache, so the tile does not say it wrote nothing.
    expect(tokens).not.toHaveTextContent("nothing written to cache");
    expect(screen.getByTestId("inst-cost")).toHaveTextContent(
      "cache hit not recorded",
    );
  });

  it("shows a rebuilt cache as the share of input written to it, beside a hit rate that leaves writes out (A-08)", async () => {
    // Half the input went into cache writes and little was read back: the
    // hit rate, which leaves writes out of its denominator, still reads high.
    await renderTab(
      props({
        cost: readOk(
          costRollup({
            micros: "4130000",
            tokens: {
              inputUncached: 5_000,
              cacheRead: 395_000,
              cacheWrite5m: 300_000,
              cacheWrite1h: 100_000,
              output: 20_000,
              reasoning: 0,
            },
            byClass: {
              ...RELEASE_RUN_CLASSES,
              cacheWrite5m: "1875000",
              cacheWrite1h: "1000000",
              output: "2246106",
              reasoning: "0",
            },
            cacheSaving: "3555000",
            cacheHitRate: 0.9875,
            modelCalls: 8,
          }),
        ),
      }),
    );
    const tokens = screen.getByTestId("inst-tokens");
    expect(tokens).toHaveTextContent("Cache hit 98.8% of input");
    // 400,000 written of 800,000 input tokens.
    expect(tokens).toHaveTextContent("50% of input written to cache");
    expect(tokens).not.toHaveTextContent("nothing written to cache");
  });

  it("leaves the total without a cost when a model the run used has no recorded split, and names no recorded cost or price entry the record lacks (negative)", async () => {
    const rollup = releaseRunCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    await renderTab(
      props({
        run: runRow({ ...RELEASE_RUN, cost: null }),
        cost: readOk({
          rollup: {
            ...rollup,
            cost: null,
            priceEntryIds: [],
            // The rollup priced none of the model's calls.
            byModel: rollup.byModel.map((row) => ({
              ...row,
              cost: null,
              costByClass: null,
              cacheSaving: null,
              hasUnpriced: true,
            })),
          },
        }),
      }),
    );
    const reasoning = screen
      .getAllByTestId("token-class-row")
      .find((row) => row.dataset.class === "reasoning");
    expect(reasoning?.children[2]).toHaveTextContent("not recorded");
    expect(screen.getByTestId("token-class-total")).toHaveTextContent(
      "not recorded",
    );
    const note = screen.getByTestId("token-class-note");
    expect(note).toHaveTextContent(
      "The rollup recorded no cost for a model this run used",
    );
    expect(note).not.toHaveTextContent("The run recorded");
    expect(note).not.toHaveTextContent("It was priced with");
    expect(
      within(screen.getByTestId("prompt-composition")).getByText("Basis")
        .nextElementSibling,
    ).toHaveTextContent("not recorded");
  });

  it("names a recorded cost whose basis nobody recorded as such in the classes' note (negative)", async () => {
    const rollup = releaseRunCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    await renderTab(
      props({
        cost: readOk({
          rollup: {
            ...rollup,
            cost: { micros: "4130000", currency: "USD", basis: null },
          },
        }),
      }),
    );
    expect(screen.getByTestId("token-class-note")).toHaveTextContent(
      "The run recorded $4.13 basis not recorded.",
    );
  });

  it("draws the ledger from get_run_turns when the transcript read fails (negative)", async () => {
    await renderTab(
      props({ transcript: readError("frame_store_unreachable", 502) }),
    );
    expect(screen.getAllByTestId("waterfall-row")).toHaveLength(7);
    expect(screen.getByTestId("inst-shape-value")).toHaveTextContent("7turns");
    expect(screen.getByTestId("tool-calls")).toHaveTextContent(
      "The transcript was not read, so the calls are not counted.",
    );
  });

  it("reads get_run_turns once, for this run", async () => {
    const tab = props();
    const { source, calls } = runSource({
      detail: readOk(tab.detail),
      turns: readOk(costTurns(releaseRunTurns())),
    });
    await renderTab({ ...tab, source });
    expect(calls.turns).toEqual([[ctx, RELEASE_RUN.id]]);
  });

  it("names the per-turn read's failure where the ledger would be (negative)", async () => {
    await renderTab(
      props({ turns: readError("frame_store_unreachable", 502) }),
    );
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent(
      "frame_store_unreachable",
    );
    expect(screen.queryAllByTestId("waterfall-row")).toHaveLength(0);
    expect(screen.queryByTestId("waterfall-cut")).toBeNull();
    expect(screen.getByTestId("inst-shape-value")).toHaveTextContent(
      "not recorded",
    );
    const tile = screen.getByTestId("inst-cost");
    expect(tile).not.toHaveTextContent("per turn");
    expect(tile).not.toHaveTextContent("was the dearest");
    expect(screen.queryAllByTestId("inst-cost-col")).toHaveLength(0);
    // The run's cost is the rollup's, which the failed read does not touch.
    expect(tile).toHaveTextContent("$4.13");
  });

  it("says the ledger shows the run's first turns when the run has more than one read carries (negative)", async () => {
    const turns = costTurns(releaseRunTurns());
    await renderTab(props({ turns: readOk({ ...turns, complete: false }) }));
    expect(screen.getAllByTestId("waterfall-row")).toHaveLength(7);
    expect(screen.getByTestId("waterfall-cut")).toHaveTextContent(
      "The run is longer than one read carries, so this shows its first 7 turns.",
    );
  });

  it("draws every turn of a run whose transcript stopped short, with no cut note (negative)", async () => {
    const cut = costTranscript(releaseRunTurns());
    await renderTab(
      props({
        transcript: readOk({
          ...cut,
          entries: cut.entries.slice(0, 20),
          cursor: "next",
          complete: false,
        }),
      }),
    );
    expect(screen.getAllByTestId("waterfall-row")).toHaveLength(7);
    expect(screen.queryByTestId("waterfall-cut")).toBeNull();
  });
});

/** The release run's cost with its rollup and baseline changed as a test says. */
function releaseCost(
  over: Partial<NonNullable<RunCost["rollup"]>>,
  baseline: RunCost["baseline"] = null,
): RunCost {
  const cost = releaseRunCost();
  if (cost.rollup === null) throw new Error("the release run is rolled up");
  return { ...cost, rollup: { ...cost.rollup, ...over }, baseline };
}

const usd = (micros: string, basis: "mixed" | "estimated" = "mixed") => ({
  micros,
  currency: "USD",
  basis,
});

/** The agent's 30 days before the release run: a $2.89 median run, 62% advanced. */
const BASELINE: NonNullable<RunCost["baseline"]> = {
  windowDays: 30,
  before: new Date(NOW - 780_000).toISOString(),
  runs: 12,
  medianCost: usd("2890000"),
  productiveRatio: 0.62,
};

describe("CostTab against the agent's baseline (#3984)", () => {
  it("prints the gap to the agent's median run and the points against its 30-day ratio", async () => {
    const { container } = await renderTab(
      props({ cost: readOk(releaseCost({}, BASELINE)) }),
    );
    // $4.13 against a $2.89 median; 71% against 62%.
    expect(screen.getByTestId("inst-cost-median")).toHaveTextContent(
      "+$1.24 vs this agent's median run $2.89",
    );
    expect(screen.getByTestId("inst-ratio-baseline")).toHaveTextContent(
      "+9 pts vs 30-day 62%",
    );
    expect(screen.getByTestId("inst-cost")).not.toHaveTextContent(
      "this agent's median run is not recorded",
    );
    expect(screen.getByTestId("inst-ratio")).not.toHaveTextContent(
      "this agent's 30-day ratio is not recorded",
    );
    await expectNoAxe(container);
  });

  it("prints a run below its baseline with a minus sign", async () => {
    await renderTab(
      props({
        cost: readOk(
          releaseCost(
            { productiveRatio: 0.5 },
            { ...BASELINE, medianCost: usd("5000000") },
          ),
        ),
      }),
    );
    expect(screen.getByTestId("inst-cost-median")).toHaveTextContent(
      "−$0.87 vs this agent's median run $5.00",
    );
    expect(screen.getByTestId("inst-ratio-baseline")).toHaveTextContent(
      "−12 pts vs 30-day 62%",
    );
  });

  it("says not recorded for a figure too few of the agent's runs carry (negative)", async () => {
    await renderTab(
      props({
        cost: readOk(
          releaseCost(
            {},
            { ...BASELINE, medianCost: null, productiveRatio: null },
          ),
        ),
      }),
    );
    expect(screen.getByTestId("inst-cost")).toHaveTextContent(
      "this agent's median run is not recorded",
    );
    expect(screen.getByTestId("inst-ratio")).toHaveTextContent(
      "this agent's 30-day ratio is not recorded",
    );
    expect(screen.queryByTestId("inst-cost-median")).toBeNull();
  });

  it("names why the unproductive steps made no progress, and counts advanced against did not", async () => {
    const { container } = await renderTab(
      props({
        cost: readOk(
          releaseCost({
            productiveRatio: 68 / 96,
            advancedSteps: 68,
            unproductiveSteps: 28,
            unproductiveCauses: { failed: 4, repeated: 12, retried: 12 },
          }),
        ),
      }),
    );
    const tile = screen.getByTestId("inst-ratio");
    expect(screen.getByTestId("inst-ratio-causes")).toHaveTextContent(
      "28 steps did not advance the task: 4 failed, 12 repeated an earlier call, 12 retried.",
    );
    expect(tile).toHaveTextContent("advanced68 steps");
    expect(tile).toHaveTextContent("did not28 steps");
    // The retries alone gave way to the causes.
    expect(tile).not.toHaveTextContent("The rollup recorded");
    expect(screen.getByTestId("prompt-composition")).toHaveTextContent(
      "68 of 96 steps advanced the task",
    );
    await expectNoAxe(container);
  });

  it("names only the causes the rollup recorded, and says so when every step advanced", async () => {
    await renderTab(
      props({
        cost: readOk(
          releaseCost({
            productiveRatio: 1,
            advancedSteps: 96,
            unproductiveSteps: 0,
            unproductiveCauses: { failed: 0, repeated: 0, retried: 0 },
          }),
        ),
      }),
    );
    expect(screen.getByTestId("inst-ratio-causes")).toHaveTextContent(
      "Every step the rollup graded advanced the task.",
    );
  });

  it("keeps the retry count on a run rolled up before its steps were graded (negative)", async () => {
    await renderTab(props());
    expect(screen.queryByTestId("inst-ratio-causes")).toBeNull();
    expect(screen.getByTestId("inst-ratio")).toHaveTextContent(
      "The rollup recorded 2 retries.",
    );
  });
});

describe("CostTab's tool costs (#3892)", () => {
  it("lists the most expensive tools with their estimated cost and fills the Tool calls area", async () => {
    const { container } = await renderTab(
      props({
        cost: readOk(
          releaseCost({
            byTool: [
              { name: "Grep", calls: 4, resultTokens: 800, cost: null },
              {
                name: "Read",
                calls: 5,
                resultTokens: 60_000,
                cost: usd("300000", "estimated"),
              },
              {
                name: "mcp__github__list_pull_requests",
                calls: 1,
                resultTokens: 90_000,
                cost: usd("450000", "estimated"),
              },
            ],
          }),
        ),
      }),
    );
    const tools = screen.getAllByTestId("dearest-tool");
    expect(tools.map((row) => row.textContent)).toEqual([
      "mcp__github__list_pull_requests1 call · $0.45",
      "Read5 calls · $0.30",
      "Grep4 calls · not recorded",
    ]);
    expect(screen.getByTestId("dearest-tools-note")).toHaveTextContent(
      "Each tool's cost is an estimate",
    );
    const results = screen
      .getAllByTestId("area-row")
      .find((row) => row.dataset.area === "results");
    expect(results).toHaveTextContent("$0.75");
    expect(results).toHaveTextContent("estimate");
    expect(screen.getByTestId("spend-by-area")).toHaveTextContent(
      "Most expensive tools",
    );
    await expectNoAxe(container);
  });
});

describe("CostTab's finding pins (#4001)", () => {
  const FINDING = "fnd_0123456789abcdefghjkmn";
  const turns = costTurns(releaseRunTurns());
  const fifth = turns.turns[4];
  const findings = (
    citation: RunFindings["findings"][number]["citation"],
  ): Read<RunFindings> =>
    readOk({
      findings: [
        {
          id: FINDING,
          kind: "repeated_shell_commands",
          subject: "Bash",
          saving: usd("60000", "estimated"),
          confidence: "high",
          citation,
        },
      ],
    });

  it("reads the run's findings beside its turns and pins one to the turn it cites", async () => {
    if (fifth === undefined) throw new Error("the release run has seven turns");
    const tab = props({
      findings: findings({
        runLevel: false,
        frames: [{ seq: fifth.seq }],
        framesTotal: 1,
      }),
    });
    await renderTab(tab);
    const pins = screen.getAllByTestId("waterfall-pin");
    expect(pins.map((pin) => pin.getAttribute("data-turn"))).toEqual(["5"]);
    const rows = screen.getAllByTestId("waterfall-row");
    const link = within(rows[4] ?? document.body).getByRole("link", {
      name: "Repeated shell commands",
    });
    expect(link.getAttribute("href")).toBe(
      `/acme/core-platform/runs/${RELEASE_RUN.id}?tab=cost&finding=${FINDING}`,
    );
  });

  it("opens the finding's evidence over the tab when the URL names it", async () => {
    const tab = props({
      finding: FINDING,
      findingEvidence: readOk({
        finding: {
          id: FINDING,
          kind: "repeated_shell_commands",
          level: "tool",
          subject: "Bash",
          saving: usd("60000", "estimated"),
          confidence: "high",
          window: {
            from: "2026-08-16T00:00:00.000Z",
            to: "2026-09-15T00:00:00.000Z",
          },
          why: "Why.",
          fix: "Fix.",
          runs: 1,
          calls: 2,
        },
        calls: 2,
        coveredCalls: 2,
        measuredTokens: 100,
        counterfactualTokens: 0,
        measured: { micros: "60000", currency: "USD" },
        counterfactual: { micros: "0", currency: "USD" },
        runs: [],
      }),
    });
    await renderTab(tab);
    expect(screen.getByTestId("spend-evidence-dialog")).toBeTruthy();
    expect(screen.getByTestId("cost-tab")).toBeTruthy();
  });

  it("reads no evidence for a value that is not a finding id (negative)", async () => {
    // The source refuses an evidence read the test did not hand it, so a
    // read here would fail the render.
    await renderTab(props({ finding: "../spend" }));
    expect(screen.queryByTestId("spend-evidence-dialog")).toBeNull();
  });
});

describe("CostTab after a findings read fails", () => {
  it("says the pins are not recorded rather than drawing none (negative)", async () => {
    await renderTab(
      props({ findings: readError("findings_unreachable", 502) }),
    );
    expect(screen.queryByTestId("waterfall-pin")).toBeNull();
    for (const row of screen.getAllByTestId("waterfall-row"))
      expect(row.lastElementChild).toHaveTextContent("not recorded");
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent(
      "findings_unreachable",
    );
    // The rest of the tab still draws.
    expect(screen.getAllByTestId("waterfall-row")).toHaveLength(7);
  });
});
