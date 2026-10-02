// @vitest-environment jsdom
// The detector cards (spend spec, Detectors and Counting rules 3 to 5). Each
// kind renders its finding text from the catalogue, filled from the finding's
// runs, calls, and saving and from the figures the findings job stored for
// the kind (#5023). A finding stored before the job wrote values shows the
// detector's own text instead, never a zero. Each card leads with its amount
// and its share of the workspace's spend, side by side, and a share with no
// spend to divide reads not recorded, never zero. Model class fit says
// estimated and names the model it repriced against. Prompt habits says
// Needs prompt text when the stored retention mode is digest_only. Standing
// context names its weekly price per 1,000 tokens after the share. A kind
// with no card of its own draws the generic card. An agent finding draws the
// agent's avatar with its registered harness (#4871).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cost } from "@/data/contracts/money";
import type { SpendFinding } from "@/data/contracts/spend";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, messages } from "@/test/intl";
import { pickOption } from "@/test/select";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("./actions", () => ({
  recordFindingFixAction: vi.fn(),
  dismissFindingAction: vi.fn(),
}));

const { FindingsList } = await import("./findings-list");

const AT = { org: "acme", ws: "core-platform" };
const WINDOW = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
};

/** $100.00 of priced spend over the window, so a $2.50 finding is 2.5% of it. */
const SPEND: Cost = {
  micros: "100000000",
  currency: "USD",
  basis: "gateway_observed",
};

type Kind = SpendFinding["kind"];
type Values = NonNullable<SpendFinding["values"]>;

/** Every kind the findings job writes today. A kind a later lane adds draws the generic card. */
const KINDS = [
  "cache_writes_never_read",
  "duplicate_tool_calls",
  "repeated_shell_commands",
  "unpaged_results",
  "spin_loops",
  "standing_context",
  "idle_cache_rewrites",
  "cache_busts",
  "model_class_fit",
  "repeated_instructions",
  "recurring_runs",
  "spend_with_no_outcome",
  "retry_loops",
] as const satisfies readonly Kind[];
type Known = (typeof KINDS)[number];

/** The detector's own text for each kind, as packages/billing writes it. */
const WHY: Record<Known, string> = {
  cache_writes_never_read:
    "3 runs wrote 120,000 prompt-cache tokens and read none of them back.",
  duplicate_tool_calls:
    "7 calls on 3 runs repeated tool calls with an identical input and output digest earlier in the same run. Each came from a turn that made no other call.",
  repeated_shell_commands:
    "7 calls on 3 runs re-ran shell commands whose identical input had already returned the identical output earlier in the run. Each came from a turn that made no other call.",
  unpaged_results:
    "github.search_code returned 4 results over 5,000 tokens on 3 runs. Later requests read them 7 times.",
  spin_loops:
    "On 3 runs, a call ran 20 or more times in a row and returned the same result each time. 7 calls came from turns that made only those repeats.",
  standing_context:
    "3 runs re-sent 52,000 estimated tokens of standing context on every model call after the first: 40,000 of tool definitions and 12,000 of steering.",
  idle_cache_rewrites:
    "reviewer waited 5 to 15 minutes 7 times, and each wait rewrote a 48,000-token cache on average. A keep-alive would have cost $0.40 against $2.90 in rewrites.",
  cache_busts:
    "reviewer rewrote its cache 7 times because the start of the prompt changed. The rewrites cost $2.50 more than reading the cache back.",
  model_class_fit:
    "3 runs changed no file. Repriced from claude-opus-5-5 to claude-sonnet-5 at list prices, they would have cost an estimated 31% less.",
  repeated_instructions:
    'Runs received "Run the tests before you open a pull request" 7 times this month. A steering record would reach every run it applies to with no paste.',
  recurring_runs:
    "12 runs started with the same prompt in the last 30 days. 3 of them changed nothing. A run changed nothing when it made no mutating call and changed no file.",
  spend_with_no_outcome:
    "3 runs ended with nothing kept. Each pull request closed unmerged or was reverted within 14 days of its merge, or the run was abandoned before it opened one.",
  retry_loops:
    "On 3 runs, a call failed 3 or more times in a row with the same error, and no write or file change came between the attempts. 7 calls came from turns that made only those retries.",
};

const usd = (micros: string) => ({ micros, currency: "USD" });
const estimated = (micros: string) => ({
  ...usd(micros),
  basis: "estimated" as const,
});

/** The figures the job stores for each kind whose text needs them (#5023). */
const VALUES: Partial<Record<Known, Values>> = {
  spin_loops: { kind: "spin_loops", tool: "Bash", repeats: 42 },
  retry_loops: { kind: "retry_loops", tool: "Read", failures: 4 },
  standing_context: {
    kind: "standing_context",
    resentTokens: 52_000,
    toolDefinitionTokens: 40_000,
    steeringTokens: 12_000,
    contextFrameTokens: null,
    provider: {
      name: "github",
      tokens: 18_000,
      tools: 40,
      toolsCalled: 3,
      weeklyPrice: estimated("523980000"),
    },
    weeklyPricePerThousand: estimated("29110000"),
  },
  model_class_fit: {
    kind: "model_class_fit",
    model: "claude-opus-5-5",
    lighterModel: "claude-sonnet-5",
    unchangedRuns: 3,
    editedRuns: 0,
  },
  repeated_instructions: {
    kind: "repeated_instructions",
    retention: "content_exact",
    sentence: "Run the tests before you open a pull request",
    prompts: 7,
    promptRuns: 3,
    others: 0,
  },
  recurring_runs: {
    kind: "recurring_runs",
    groupSize: 12,
    unchanged: 3,
    otherPrompts: 0,
  },
  spend_with_no_outcome: {
    kind: "spend_with_no_outcome",
    closedUnmerged: 2,
    reverted: 1,
    abandoned: 0,
  },
  cache_writes_never_read: {
    kind: "cache_writes_never_read",
    writtenTokens: 120_000,
  },
  idle_cache_rewrites: {
    kind: "idle_cache_rewrites",
    minWaitMinutes: 5,
    maxWaitMinutes: 15,
    averageTokens: 48_000,
    keepAlive: usd("400000"),
    rewrites: usd("2900000"),
    pricedRewrites: 7,
    unknownRewrites: 0,
  },
  cache_busts: {
    kind: "cache_busts",
    firstChange: "the system context",
    firstChangeBusts: 5,
    pricedBusts: 7,
    unknownBusts: 0,
  },
  unpaged_results: {
    kind: "unpaged_results",
    results: 4,
    retention: "content_exact",
    quoted: { results: 0, reads: 0 },
    unchecked: { results: 0, reads: 0 },
  },
};

/** The text each kind's card writes from the catalogue. */
const WRITTEN: Record<Known, string> = {
  spin_loops:
    "reviewer ran Bash 42 times in a row in one run with an unchanged result. 7 calls on 3 runs came from turns that made only those repeats. The round trips cost $2.50.",
  retry_loops:
    "reviewer called Read 4 times in a row in one run, and each call failed with the same error. 7 calls on 3 runs came from turns that made only those retries. The round trips cost $2.50.",
  duplicate_tool_calls:
    "reviewer repeated tool calls that had already returned the same result in the run. 7 calls on 3 runs each came from a turn that made no other call. The round trips cost $2.50.",
  repeated_shell_commands:
    "Agents re-ran shell commands that had already returned the same result in the run. 7 calls on 3 runs each came from a turn that made no other call. The round trips cost $2.50.",
  standing_context:
    "Runs by reviewer re-sent 52,000 estimated tokens of standing context on every request after the first. github adds 18,000 tokens to every request. Agents called 3 of its 40 tools this month. Its definitions cost $523.98 a week.",
  model_class_fit:
    "reviewer ran 3 runs on claude-opus-5-5 that changed no file. On claude-sonnet-5 they would have cost an estimated $2.50 less.",
  repeated_instructions:
    'Runs received "Run the tests before you open a pull request" 7 times this month. A steering record would reach every run it applies to with no paste.',
  recurring_runs:
    "12 runs started with the same prompt this month, and 3 of them changed nothing. The runs that changed nothing cost $2.50.",
  spend_with_no_outcome:
    "Ana Ruiz spent $2.50 on 3 runs that ended with nothing kept this month. 2 runs opened pull requests that all closed unmerged. 1 run had a pull request reverted within 14 days of its merge.",
  cache_writes_never_read:
    "3 runs by reviewer wrote 120,000 prompt-cache tokens and read none of them back. The writes cost $2.50 more than sending the same tokens uncached.",
  idle_cache_rewrites:
    "reviewer waited 5 to 15 minutes 7 times, and each wait rewrote a 48,000-token cache on average. A keep-alive would have cost $0.40 against $2.90 in rewrites.",
  cache_busts:
    "reviewer rewrote its cache 7 times because the start of the prompt changed. The first change was most often in the system context (5 times). The rewrites cost $2.50 more than reading the cache back.",
  unpaged_results:
    "github.search_code returned 4 results over 5,000 tokens on 3 runs. Later requests read them 7 times. Paging them at 4,000 tokens would have saved $2.50.",
};

function findingOf(
  kind: Known,
  over: Partial<SpendFinding> = {},
): SpendFinding {
  const values = VALUES[kind];
  return {
    id: `fnd_${kind.replaceAll("_", "")}`,
    kind,
    level: "agent",
    subject: "reviewer",
    saving: { micros: "2500000", currency: "USD", basis: "gateway_observed" },
    confidence: "high",
    window: WINDOW,
    why: WHY[kind],
    fix: "Fix.",
    ...(values === undefined ? {} : { values }),
    runs: 3,
    calls: 7,
    ...over,
  };
}

/** A finding as a row the job wrote before it stored values reads. */
function withoutValues(finding: SpendFinding): SpendFinding {
  const { values: _values, ...rest } = finding;
  return rest;
}

const ALL = KINDS.map((kind) =>
  kind === "spend_with_no_outcome"
    ? findingOf(kind, { level: "operator", subject: "prn_ana" })
    : kind === "repeated_shell_commands"
      ? findingOf(kind, { level: "tool", subject: "Bash" })
      : kind === "unpaged_results"
        ? findingOf(kind, { level: "tool", subject: "github.search_code" })
        : findingOf(kind),
);

const NAMES = { prn_ana: "Ana Ruiz" };

function list(
  findings: readonly SpendFinding[],
  spend: Cost | null = SPEND,
  provider: (node: ReactNode) => ReactNode = (node) => (
    <IntlProvider>{node}</IntlProvider>
  ),
) {
  return render(
    provider(
      <FindingsList findings={findings} spend={spend} names={NAMES} at={AT} />,
    ),
  );
}

/** Shows every card: the first page holds ten. */
async function showAll(user: ReturnType<typeof userEvent.setup>) {
  await pickOption(user, screen.getByRole("combobox", { name: "Rows" }), "25");
  await waitFor(() => {
    expect(document.querySelectorAll("li[data-finding]")).toHaveLength(
      KINDS.length,
    );
  });
}

function card(id: string): HTMLElement {
  const li = document.querySelector<HTMLElement>(`li[data-finding="${id}"]`);
  if (li === null) throw new Error(`no card ${id}`);
  return li;
}

function figure(li: HTMLElement, name: string): HTMLElement | null {
  return li.querySelector<HTMLElement>(`dd[data-figure="${name}"]`);
}

function textOf(li: HTMLElement): Element | null {
  return li.querySelector("[data-finding-text]");
}

afterEach(async () => {
  if (document.body.childElementCount > 0) await expectNoAxe(document.body);
  cleanup();
});

describe("Detector cards", () => {
  it("renders each kind's finding text from its values", async () => {
    const user = userEvent.setup();
    list(ALL);
    await showAll(user);
    for (const finding of ALL) {
      const text = textOf(card(finding.id));
      expect(text?.getAttribute("data-finding-text")).toBe("catalogue");
      expect(text).toHaveTextContent(WRITTEN[finding.kind as Known]);
    }
  });

  // #5023: a row the job wrote before it stored values carries none, and its
  // card shows the detector's own sentence rather than a figure of zero.
  it("shows the detector's sentence for a stored finding with no values (negative)", async () => {
    const user = userEvent.setup();
    list(ALL.map(withoutValues));
    await showAll(user);
    for (const finding of ALL) {
      const text = textOf(card(finding.id));
      if (VALUES[finding.kind as Known] === undefined) {
        // The repeat kinds name only the runs, the calls, and the saving.
        expect(text?.getAttribute("data-finding-text")).toBe("catalogue");
        continue;
      }
      expect(text?.getAttribute("data-finding-text")).toBe("detector");
      expect(text).toHaveTextContent(WHY[finding.kind as Known]);
    }
  });

  it("shows the detector's sentence when the values name another kind (negative)", () => {
    list([
      findingOf("spin_loops", { values: VALUES.retry_loops }),
    ]);
    const text = textOf(card("fnd_spinloops"));
    expect(text?.getAttribute("data-finding-text")).toBe("detector");
    expect(text).toHaveTextContent(WHY.spin_loops);
  });

  it("writes one run and one call in the singular", () => {
    list([
      findingOf("spin_loops", { runs: 1, calls: 1 }),
      findingOf("spend_with_no_outcome", {
        runs: 1,
        calls: 1,
        values: {
          kind: "spend_with_no_outcome",
          closedUnmerged: 1,
          reverted: 0,
          abandoned: 0,
        },
      }),
    ]);
    expect(card("fnd_spinloops")).toHaveTextContent(
      "1 call on 1 run came from a turn that made only those repeats.",
    );
    expect(card("fnd_spendwithnooutcome")).toHaveTextContent(
      "reviewer spent $2.50 on 1 run that ended with nothing kept this month. 1 run opened pull requests that all closed unmerged.",
    );
  });

  // #4506 pass 7: a repeat finding counts every call its counted turns made,
  // so the number the card prints is a count of calls, as both lines name it.
  it("prints a repeat finding's number as calls in its text and in its evidence line", () => {
    list([
      findingOf("duplicate_tool_calls", { runs: 1, calls: 3 }),
      findingOf("repeated_shell_commands", {
        level: "tool",
        subject: "Bash",
        runs: 1,
        calls: 1,
      }),
    ]);
    const duplicate = card("fnd_duplicatetoolcalls");
    expect(duplicate).toHaveTextContent(
      "3 calls on 1 run each came from a turn that made no other call.",
    );
    expect(duplicate).toHaveTextContent("evidence 1 runs · 3 calls");
    expect(card("fnd_repeatedshellcommands")).toHaveTextContent(
      "1 call on 1 run came from a turn that made no other call.",
    );
  });

  // #5023: spin loops and retry loops count each cited call too, so their
  // text and their evidence line name the same number of calls.
  it("prints a loop finding's number as calls in its text and in its evidence line", () => {
    list([
      findingOf("spin_loops", { runs: 2, calls: 44 }),
      findingOf("retry_loops", { runs: 1, calls: 3 }),
    ]);
    const spin = card("fnd_spinloops");
    expect(spin).toHaveTextContent(
      "44 calls on 2 runs came from turns that made only those repeats.",
    );
    expect(spin).toHaveTextContent("evidence 2 runs · 44 calls");
    const retry = card("fnd_retryloops");
    expect(retry).toHaveTextContent(
      "3 calls on 1 run came from turns that made only those retries.",
    );
    expect(retry).toHaveTextContent("evidence 1 runs · 3 calls");
  });

  it("leads each card with its amount and its share of the workspace's spend, side by side", async () => {
    const user = userEvent.setup();
    list(ALL);
    await showAll(user);
    for (const finding of ALL) {
      const li = card(finding.id);
      const figures = li.querySelector('[data-testid="finding-figures"]');
      const text = textOf(li);
      if (figures === null || text === null)
        throw new Error(`card ${finding.id} lacks figures or text`);
      // The amount and the share come first, in one row, before the text.
      expect(
        Array.from(figures.querySelectorAll("dd[data-figure]"))
          .map((dd) => dd.getAttribute("data-figure"))
          .slice(0, 2),
      ).toEqual(["amount", "share"]);
      expect(
        figures.compareDocumentPosition(text) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(figure(li, "amount")).toHaveTextContent("$2.50");
      expect(figure(li, "share")).toHaveTextContent(/^2\.5%$/);
    }
  });

  it("reads the share as not recorded when no spend divides it, never as zero (negative)", () => {
    list([findingOf("spin_loops")], null);
    const share = figure(card("fnd_spinloops"), "share");
    expect(share?.querySelector('[data-recorded="false"]')).not.toBeNull();
    expect(share).not.toHaveTextContent(/0%/);
    expect(figure(card("fnd_spinloops"), "amount")).toHaveTextContent("$2.50");
  });

  it("reads the share as not recorded when the spend is in another currency (negative)", () => {
    list([findingOf("spin_loops")], { ...SPEND, currency: "EUR" });
    expect(
      figure(card("fnd_spinloops"), "share")?.querySelector(
        '[data-recorded="false"]',
      ),
    ).not.toBeNull();
  });

  it("labels model class fit estimated and names the model it repriced against", () => {
    list([findingOf("model_class_fit"), findingOf("spin_loops")]);
    const fit = card("fnd_modelclassfit");
    expect(
      fit.querySelector('[data-badge="estimated"]'),
    ).toHaveTextContent("Estimated");
    expect(within(fit).getByText("Estimated saving")).toBeInTheDocument();
    expect(textOf(fit)).toHaveTextContent(
      "On claude-sonnet-5 they would have cost an estimated $2.50 less.",
    );
    // A measured kind carries no estimate label.
    const spin = card("fnd_spinloops");
    expect(spin.querySelector('[data-badge="estimated"]')).toBeNull();
    expect(within(spin).getByText("Amount at stake")).toBeInTheDocument();
  });

  it("names the steps that only read when model class fit's runs also edited", () => {
    list([
      findingOf("model_class_fit", {
        values: {
          kind: "model_class_fit",
          model: "claude-opus-5-5",
          lighterModel: "claude-sonnet-5",
          unchangedRuns: 2,
          editedRuns: 1,
        },
      }),
    ]);
    expect(textOf(card("fnd_modelclassfit"))).toHaveTextContent(
      "reviewer ran 2 runs on claude-opus-5-5 that changed no file, and 1 run with edit steps and steps that only read. On claude-sonnet-5 the steps that only read would have cost an estimated $2.50 less.",
    );
  });

  // #5023: the badge reads the retention mode the job stored, not the words
  // of the detector's sentence.
  it("says Needs prompt text when the stored retention mode is digest_only, and shows the whole-prompt repeats", () => {
    const digestOnly = findingOf("repeated_instructions", {
      // The detector's sentence does not name the badge, so only the stored
      // retention mode can show it.
      why: "Runs received the same prompt 7 times this month, across 3 runs.",
      values: {
        kind: "repeated_instructions",
        retention: "digest_only",
        sentence: null,
        prompts: 7,
        promptRuns: 3,
        others: 1,
      },
    });
    list([digestOnly]);
    const li = card("fnd_repeatedinstructions");
    expect(
      li.querySelector('[data-badge="needs-prompt-text"]'),
    ).toHaveTextContent("Needs prompt text");
    expect(textOf(li)).toHaveTextContent(
      "Runs received the same prompt 7 times this month, across 3 runs. 1 other prompt also repeated. This workspace keeps only a digest of each prompt, so the sentences that repeat cannot be shown.",
    );
  });

  it("shows no Needs prompt text where the stored retention mode keeps prompt text, whatever the sentence says (negative)", () => {
    list([
      findingOf("repeated_instructions", {
        why: "Needs prompt text: this sentence is not where the badge comes from.",
      }),
    ]);
    const li = card("fnd_repeatedinstructions");
    expect(li.querySelector('[data-badge="needs-prompt-text"]')).toBeNull();
    expect(textOf(li)).toHaveTextContent(
      'Runs received "Run the tests before you open a pull request" 7 times this month.',
    );
  });

  it("shows no Needs prompt text on a stored finding with no values (negative)", () => {
    list([withoutValues(findingOf("repeated_instructions"))]);
    expect(
      card("fnd_repeatedinstructions").querySelector(
        '[data-badge="needs-prompt-text"]',
      ),
    ).toBeNull();
  });

  it("names standing context's weekly price per 1,000 tokens after the share", () => {
    list([findingOf("standing_context"), findingOf("spin_loops")]);
    const li = card("fnd_standingcontext");
    expect(
      Array.from(li.querySelectorAll("dd[data-figure]")).map((dd) =>
        dd.getAttribute("data-figure"),
      ),
    ).toEqual(["amount", "share", "unit"]);
    expect(
      within(li).getByText("Weekly price per 1,000 tokens"),
    ).toBeInTheDocument();
    expect(figure(li, "unit")).toHaveTextContent("$29.11");
    // A detector that names no per-unit price shows none.
    expect(figure(card("fnd_spinloops"), "unit")).toBeNull();
  });

  it("reads standing context's weekly price as not recorded when the job recorded none, never as zero (negative)", () => {
    const values = VALUES.standing_context;
    if (values?.kind !== "standing_context") throw new Error("no values");
    list([
      findingOf("standing_context", {
        values: {
          ...values,
          provider: null,
          contextFrameTokens: 8_000,
          weeklyPricePerThousand: null,
        },
      }),
    ]);
    const li = card("fnd_standingcontext");
    expect(
      figure(li, "unit")?.querySelector('[data-recorded="false"]'),
    ).not.toBeNull();
    // With no provider read, the text names the re-sent tokens alone.
    expect(textOf(li)).toHaveTextContent(
      "Runs by reviewer re-sent 52,000 estimated tokens of standing context on every request after the first. The amount leaves out the context frames, which the fix does not change.",
    );
    expect(textOf(li)).not.toHaveTextContent("adds");
  });

  it("reads standing context's weekly price as not recorded on a stored finding with no values (negative)", () => {
    list([withoutValues(findingOf("standing_context"))]);
    expect(
      figure(card("fnd_standingcontext"), "unit")?.querySelector(
        '[data-recorded="false"]',
      ),
    ).not.toBeNull();
  });

  it("names the part of the prompt that changed first, or says it is unknown", () => {
    list([
      findingOf("cache_busts", {
        values: {
          kind: "cache_busts",
          firstChange: null,
          firstChangeBusts: null,
          pricedBusts: 5,
          unknownBusts: 7,
        },
      }),
    ]);
    expect(textOf(card("fnd_cachebusts"))).toHaveTextContent(
      "reviewer rewrote its cache 7 times because the start of the prompt changed. No request recorded a system context digest, so the part that changed is unknown. The 5 of 7 rewrites with a price cost $2.50 more than reading the cache back.",
    );
  });

  it("labels the unpaged amount an upper bound where no quote could be checked", () => {
    list([
      findingOf("unpaged_results", {
        level: "tool",
        subject: "github.search_code",
        values: {
          kind: "unpaged_results",
          results: 4,
          retention: "digest_only",
          quoted: { results: 0, reads: 0 },
          unchecked: { results: 4, reads: 7 },
        },
      }),
    ]);
    expect(textOf(card("fnd_unpagedresults"))).toHaveTextContent(
      "Paging them at 4,000 tokens would have saved $2.50. Upper bound: this workspace keeps no tool call or model call text to check for a quote, so the amount counts every re-read.",
    );
  });

  it("names the other prompts and the idle waits the finding also cites", () => {
    list([
      findingOf("recurring_runs", {
        values: {
          kind: "recurring_runs",
          groupSize: 12,
          unchanged: 3,
          otherPrompts: 2,
        },
      }),
      findingOf("idle_cache_rewrites", {
        values: {
          kind: "idle_cache_rewrites",
          minWaitMinutes: 6,
          maxWaitMinutes: 6,
          averageTokens: 48_000,
          keepAlive: usd("400000"),
          rewrites: usd("2900000"),
          pricedRewrites: 5,
          unknownRewrites: 2,
        },
      }),
    ]);
    expect(textOf(card("fnd_recurringruns"))).toHaveTextContent(
      "12 runs started with the same prompt this month, and 3 of them changed nothing. 2 other prompts also started 5 or more runs each. The runs that changed nothing cost $2.50.",
    );
    expect(textOf(card("fnd_idlecacherewrites"))).toHaveTextContent(
      "reviewer waited 6 minutes 7 times, and each wait rewrote a 48,000-token cache on average. For the 5 of 7 rewrites this finding prices, a keep-alive would have cost $0.40 against $2.90. 2 rewrites recorded no system context digest, so their cause is unknown.",
    );
  });

  it("draws the generic card for a kind with no card of its own", () => {
    // A kind a later lane adds, with the label and definition that lane
    // writes. The contract here does not list the kind yet, so the test sets
    // it on the record the way a wider contract would deliver it.
    const later = withoutValues(
      findingOf("spin_loops", {
        id: "fnd_later",
        why: "On 2 runs, a call waited on a lock 3 times in a row.",
      }),
    );
    Reflect.set(later, "kind", "lock_waits");
    const { spend } = messages;
    const withLater = {
      ...messages,
      spend: {
        ...spend,
        findings: {
          ...spend.findings,
          kind: { ...spend.findings.kind, lock_waits: "Lock waits" },
          kindDefinition: {
            ...spend.findings.kindDefinition,
            lock_waits: "A call waited on the same lock 3 or more times in a row.",
          },
        },
      },
    };
    list([later], SPEND, (node) => (
      <NextIntlClientProvider locale="en" messages={withLater} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    ));
    const li = card("fnd_later");
    expect(
      within(li).getByRole("heading", { name: "Lock waits" }),
    ).toBeInTheDocument();
    expect(textOf(li)).toHaveTextContent(
      "On 2 runs, a call waited on a lock 3 times in a row.",
    );
    expect(figure(li, "amount")).toHaveTextContent("$2.50");
    expect(figure(li, "share")).toHaveTextContent("2.5%");
    expect(figure(li, "unit")).toBeNull();
    expect(li.querySelector("[data-badge]")).toBeNull();
  });
});

describe("Agent harness (#4871)", () => {
  it("draws an agent finding's avatar with the harness the agent registered", () => {
    render(
      <IntlProvider>
        <FindingsList
          findings={[findingOf("spin_loops")]}
          spend={SPEND}
          names={NAMES}
          harnesses={{ reviewer: "stella" }}
          at={AT}
        />
      </IntlProvider>,
    );
    const li = card(findingOf("spin_loops").id);
    expect(li.querySelector("[data-agent-avatar]")).not.toBeNull();
    expect(li.querySelector('[data-harness-badge="stella"]')).not.toBeNull();
  });

  it("draws the avatar with no badge for an agent the index does not hold (negative)", () => {
    list([findingOf("spin_loops")]);
    const li = card(findingOf("spin_loops").id);
    expect(li.querySelector("[data-agent-avatar]")).not.toBeNull();
    expect(li.querySelector("[data-harness-badge]")).toBeNull();
  });

  it("draws no agent avatar on a finding about an operator or a tool (negative)", () => {
    list([
      findingOf("spend_with_no_outcome", {
        level: "operator",
        subject: "prn_ana",
      }),
      findingOf("repeated_shell_commands", { level: "tool", subject: "Bash" }),
    ]);
    for (const kind of [
      "spend_with_no_outcome",
      "repeated_shell_commands",
    ] as const) {
      expect(
        card(findingOf(kind).id).querySelector("[data-agent-avatar]"),
      ).toBeNull();
    }
  });
});
