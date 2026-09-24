// @vitest-environment jsdom
// The Cost tab (pages/run.md, Model fit and Cost; run.audit-prompt.md checks
// 4, 10 and 11): Model fit first, then the six instruments, Spend by area,
// Tool calls, the waterfall, and Spend by token class beside Prompt
// composition, every figure read from the page's one derivation.
//
// The tab is rendered over `runMetrics` of a scripted run shaped like the
// mockup's release run (`cost.builders.ts`), so the tests read figures the way
// the page derives them: the reconciliation tests hold the Tokens instrument,
// the total row of Spend by token class and the stat row to one number, and
// the waterfall's total row to the Shape of the run instrument. The negative
// tests hold every panel to "not recorded" where the record carries nothing.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunCost, RunTranscript } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { PriceBook } from "@/data/contracts/spend";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  costRollup,
  costTranscript,
  opusBook,
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
  book = opusBook(),
  agentRead = null,
}: {
  run?: RunRow;
  cost?: Read<RunCost>;
  transcript?: Read<RunTranscript>;
  book?: PriceBook | null;
  agentRead?: Read<AgentDetail> | null;
} = {}): RunTabProps {
  const detail = runDetail({ run });
  const { source } = runSource({ detail: readOk(detail) });
  return {
    ctx,
    source,
    run,
    detail,
    place: { org: "acme", ws: "core-platform", runId: run.id },
    view: { kinds: [], frames: null, body: null },
    metrics: runMetrics({ run, cost, transcript, book }),
    everything: transcript,
    cost,
    outputs: readOk(runOutputs()),
    work: Promise.resolve(readError("not_found", 404)),
    agent: agentRead,
    book,
    now: NOW,
  };
}

function renderTab(tab: RunTabProps, { withStats = false } = {}) {
  return render(
    <IntlProvider>
      {withStats ? <StatRow run={tab.run} metrics={tab.metrics} /> : null}
      {CostTab(tab)}
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
    const { container } = renderTab(props());
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

  it("holds the Tokens instrument, the token class total and the stat row to one total", () => {
    renderTab(props(), { withStats: true });
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

  it("totals the waterfall from its rows and agrees with the Shape of the run instrument", () => {
    renderTab(props());
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

  it("counts the tool calls by family and by batch from the transcript", () => {
    renderTab(props());
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

  it("reads the model fit, names the effort's reason, and offers no action on a run that fits", () => {
    renderTab(props({ agentRead: agent() }));
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

  it("argues one rung down for a small first-try run, and draws the move as a stub that says what it would do", () => {
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
    renderTab(
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

  it("argues one rung up for a run that took more than one prompt on a small class", () => {
    const run = runRow({
      ...RELEASE_RUN,
      model: { slug: "claude-haiku-4-5", provider: "anthropic", tier: "haiku" },
    });
    renderTab(props({ run }));
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

  it("claims no rung for a model the ladder does not know, and no reading for a sealed run read short (negative)", () => {
    renderTab(props({ run: runRow({ ...RELEASE_RUN, model: null }) }));
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "The run records no model class",
    );
    cleanup();
    const cut = costTranscript(releaseRunTurns());
    renderTab(
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

  it("says not recorded wherever the record carries nothing, and never prints a figure for it (negative)", () => {
    renderTab(props());
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
    // Model output is recorded and priced from the book: 36,711 tokens.
    expect(areas[6]).toHaveTextContent("36,711 tok");
    expect(areas[6]).toHaveTextContent("$0.92");
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

  it("prices the classes from the book and sets the total against the recorded cost", () => {
    renderTab(props());
    const composition = screen.getByTestId("prompt-composition");
    // Input: 124,486 at $5 plus 607,784 at $0.50 is $0.926322 over 732,270
    // tokens, $1.265000 a million, which rounds half to even at the cent.
    expect(composition).toHaveTextContent(
      "$1.26 per million across all input classes",
    );
    expect(screen.getByTestId("inst-tokens")).toHaveTextContent(
      "effective input price $1.26 per million",
    );
    expect(composition).toHaveTextContent("0% · nothing written this run");
    expect(composition).toHaveTextContent(
      "gateway_observed · counted by the proxy from the bytes that passed through it",
    );
    expect(composition).toHaveTextContent("71% of steps advanced the task");
    const total = screen.getByTestId("token-class-total");
    expect(total).toHaveTextContent("$1.844097");
    expect(total).toHaveTextContent("100%");
    expect(screen.getByTestId("token-class-note")).toHaveTextContent(
      "The run recorded $4.13 gateway_observed. It was priced with prc_01k4qj9e.",
    );
  });

  it("prices no class without a price book, and says why (negative)", () => {
    renderTab(props({ book: null }));
    for (const row of screen.getAllByTestId("token-class-row"))
      expect(row.children[2]).toHaveTextContent("not recorded");
    expect(screen.getByTestId("token-class-total")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.getByTestId("token-class-note")).toHaveTextContent(
      "The price book was not read, so no class is priced.",
    );
    expect(screen.getByTestId("inst-tokens")).toHaveTextContent(
      "effective input price not priced",
    );
    // The token counts are the rollup's, so they stand without a book.
    expect(screen.getByTestId("token-class-total-tokens")).toHaveTextContent(
      "768,981",
    );
  });

  it("says the rollup has not run rather than printing zeros (negative)", () => {
    renderTab(props({ cost: readOk({ rollup: null }) }));
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

  it("keeps the run row's cost when the cost read fails, names no basis it lacks, and claims no retry count (negative)", () => {
    renderTab(
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

  it("draws the cost tile as not recorded, with no per-turn figure and every column unpriced, when nothing carried a cost (negative)", () => {
    const unpriced = releaseRunTurns().map((turn) => ({
      ...turn,
      steps: turn.steps.map((step) =>
        step.kind === "model" ? { ...step, micros: null } : step,
      ),
    }));
    renderTab(
      props({
        run: runRow({ ...RELEASE_RUN, cost: null }),
        cost: readOk({ rollup: null }),
        transcript: readOk(costTranscript(unpriced)),
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

  it("says the cache hit was not recorded, and leaves out the reasoning and per-call parts the rollup did not carry (negative)", () => {
    renderTab(
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

  it("leaves the total unpriced when the book lacks a class the run spent in, and names no recorded cost or price entry the record lacks (negative)", () => {
    const rollup = releaseRunCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const book = opusBook();
    renderTab(
      props({
        run: runRow({ ...RELEASE_RUN, cost: null }),
        cost: readOk({ rollup: { ...rollup, cost: null, priceEntryIds: [] } }),
        book: {
          ...book,
          entries: book.entries.filter(
            (entry) => entry.tokenClass !== "reasoning",
          ),
        },
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
      "The price book has no rate for a model this run used",
    );
    expect(note).not.toHaveTextContent("The run recorded");
    expect(note).not.toHaveTextContent("It was priced with");
    expect(
      within(screen.getByTestId("prompt-composition")).getByText("Basis")
        .nextElementSibling,
    ).toHaveTextContent("not recorded");
  });

  it("names a recorded cost whose basis nobody recorded as such in the classes' note (negative)", () => {
    const rollup = releaseRunCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    renderTab(
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

  it("names the transcript read's failure where the ledger would be (negative)", () => {
    renderTab(props({ transcript: readError("frame_store_unreachable", 502) }));
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent(
      "frame_store_unreachable",
    );
    expect(screen.queryAllByTestId("waterfall-row")).toHaveLength(0);
    expect(screen.getByTestId("inst-shape-value")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.getByTestId("tool-calls")).toHaveTextContent(
      "The transcript was not read, so the calls are not counted.",
    );
  });
});
