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
import type { RunCost, RunTranscript, RunTurns } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
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
  type TurnSpec,
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
}: {
  run?: RunRow;
  cost?: Read<RunCost>;
  transcript?: Read<RunTranscript>;
  /** The tab's own `get_run_turns` read. */
  turns?: Read<RunTurns>;
  agentRead?: Read<AgentDetail> | null;
} = {}): RunTabProps {
  const detail = runDetail({ run });
  const { source } = runSource({ detail: readOk(detail), turns });
  return {
    ctx,
    source,
    run,
    detail,
    place: { org: "acme", ws: "core-platform", runId: run.id },
    view: { kinds: [], frames: null, body: null },
    metrics: runMetrics({ run, cost, transcript }),
    transcript,
    everything: transcript,
    cost,
    outputs: readOk(runOutputs()),
    work: Promise.resolve(readError("not_found", 404)),
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

  it("reads the model fit, names the effort's reason, and offers no action on a run that fits", async () => {
    await renderTab(props({ agentRead: agent() }));
    const fit = screen.getByTestId("model-fit");
    expect(fit).toHaveTextContent("generated · not the record");
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "The opus class matches this shape of work.",
    );
    expect(screen.queryByTestId("fit-move")).toBeNull();
    expect(screen.getByTestId("fit-effort-card")).toHaveTextContent(
      "no contract records the setting from the request body yet",
    );
    const read = screen.getByTestId("fit-read");
    expect(read).toHaveTextContent(
      "2 prompts · 7 turns · 24 steps · 1 tool call failed",
    );
    expect(read).toHaveTextContent(".oxagen/agents/release-manager.toml");
  });

  it("argues one rung down for a small first-try run, and draws the move as a stub that says what it would do", async () => {
    const run = runRow({
      ...RELEASE_RUN,
      turns: 2,
      steps: 5,
      model: { slug: "claude-sonnet-5", provider: "anthropic", tier: "sonnet" },
      enforcementTier: "harness",
    });
    const turns: TurnSpec[] = [
      {
        prompt: true,
        steps: [
          {
            kind: "model",
            micros: "120000",
            ms: 4_000,
            cacheRead: 10_000,
            inputUncached: 2_000,
          },
          { kind: "tools", calls: [{ name: "Read", ms: 500 }] },
        ],
      },
      {
        prompt: false,
        steps: [
          {
            kind: "model",
            micros: "90000",
            ms: 3_000,
            cacheRead: 12_000,
            inputUncached: 1_000,
          },
        ],
      },
    ];
    await renderTab(
      props({
        run,
        transcript: readOk(costTranscript(turns)),
        agentRead: agent({
          definition: {
            path: ".oxagen/agents/release.toml",
            digest: "sha256:ab",
            commitSha: "4f1c2d9",
            branch: "main",
            pullRequestUrl: "https://github.com/acme/platform/pull/12",
            source: "",
            committedAt: "2026-09-10T10:00:00.000Z",
          },
        }),
      }),
    );
    const card = screen.getByTestId("fit-model-card");
    expect(card.dataset.verdict).toBe("over");
    expect(card).toHaveTextContent("Wrong model tier");
    expect(card).toHaveTextContent(
      "This run landed in 2 turns and 5 steps, first try, with no tool call failing. The reading argues for the haiku class, one rung down the same family.",
    );
    const move = screen.getByRole("button", {
      name: "Move this agent to haiku",
    });
    expect(move).toBeDisabled();
    expect(move).toHaveAccessibleDescription(
      "Opens a Context pull request against .oxagen/agents/release.toml. No contract opens one from this page yet.",
    );
    // At the harness tier the call never passed through Oxagen.
    expect(screen.getByTestId("fit-effort-card")).toHaveTextContent(
      "The model call did not go through Oxagen, so the request body was never read.",
    );
  });

  it("argues one rung up for a run that took more than one prompt on a small class", async () => {
    const run = runRow({
      ...RELEASE_RUN,
      model: { slug: "claude-haiku-4-5", provider: "anthropic", tier: "haiku" },
    });
    await renderTab(props({ run }));
    const card = screen.getByTestId("fit-model-card");
    expect(card.dataset.verdict).toBe("under");
    expect(card).toHaveTextContent(
      "This run took 2 prompts to land on the haiku class, and 1 tool call failed. The reading argues for the sonnet class, one rung up the same family.",
    );
    // No agent was read, so the stub names the definition without a path.
    expect(
      screen.getByRole("button", { name: "Move this agent to sonnet" }),
    ).toHaveAccessibleDescription(
      "Opens a Context pull request against the agent definition. No contract opens one from this page yet.",
    );
  });

  it("claims no rung for a model the ladder does not know, and no reading for a sealed run read short (negative)", async () => {
    await renderTab(props({ run: runRow({ ...RELEASE_RUN, model: null }) }));
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "The run records no model class",
    );
    cleanup();
    const cut = costTranscript(releaseRunTurns());
    await renderTab(
      props({
        run: runRow({ ...RELEASE_RUN, sealedAt: new Date(NOW).toISOString() }),
        transcript: readOk({ ...cut, cursor: "next", complete: false }),
      }),
    );
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "the record does not carry all four yet",
    );
    expect(screen.getByTestId("fit-read")).toHaveTextContent(
      "There is no reading for this run.",
    );
    expect(screen.queryByTestId("fit-move")).toBeNull();
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
    for (const row of screen.getAllByTestId("waterfall-row"))
      expect(row.lastElementChild).toHaveTextContent("not recorded");
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
