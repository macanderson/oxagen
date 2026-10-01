// @vitest-environment jsdom
// The detector cards (spend spec, Detectors and Counting rules 3 to 5). Each
// of the twelve kinds renders its finding text: the catalogue's words filled
// from the finding's own figures, or the detector's text where it names a
// value the contract does not carry. Each card leads with its amount and its
// share of the workspace's spend, side by side, and a share with no spend to
// divide reads not recorded, never zero. Model class fit says estimated and
// names the model it repriced against. Prompt habits on a digest_only
// workspace says Needs prompt text and shows its whole-prompt repeats.
// Standing context names its weekly price per 1,000 tokens after the share. A
// kind with no card of its own draws the generic card.
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

/** The twelve kinds the findings job writes today. A kind a later lane adds draws the generic card. */
const TWELVE = [
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
] as const satisfies readonly Kind[];
type Twelve = (typeof TWELVE)[number];

/** The detector's own text for each kind, as packages/billing writes it. */
const WHY: Record<Twelve, string> = {
  cache_writes_never_read:
    "3 runs wrote 120,000 prompt-cache tokens and read none of them back.",
  duplicate_tool_calls:
    "7 turns on 3 runs only repeated tool calls with an identical input and output digest earlier in the same run.",
  repeated_shell_commands:
    "7 turns on 3 runs only re-ran shell commands whose identical input had already returned the identical output earlier in the run.",
  unpaged_results:
    "github.search_code returned 4 results over 5,000 tokens on 3 runs. Later requests read them 7 times.",
  spin_loops:
    "On 3 runs, a call ran 20 or more times in a row and returned the same result each time. 7 turns made only those repeats.",
  standing_context:
    "3 runs re-sent 52,000 estimated tokens of standing context on every turn after the first: 40,000 of tool definitions and 12,000 of steering.",
  idle_cache_rewrites:
    "reviewer waited 5 to 15 minutes 7 times, and each wait rewrote a 48,000-token cache on average. A keep-alive would have cost $0.40 against $2.90 in rewrites.",
  cache_busts:
    "reviewer rewrote its cache 7 times because the start of the prompt changed. The rewrites cost $2.50 more than reading the cache back.",
  model_class_fit:
    "3 runs changed no file. Repriced from Opus 5.5 to Sonnet 5 at list prices, they would have cost an estimated 31% less.",
  repeated_instructions:
    'Runs received "Run the tests before you open a pull request" 7 times this month. A steering record would reach every run it applies to with no paste.',
  recurring_runs:
    "12 runs started with the same prompt in the last 30 days. 3 of them changed nothing. A run changed nothing when it made no mutating call and changed no file.",
  spend_with_no_outcome:
    "3 runs ended with nothing kept. Each pull request closed unmerged or was reverted within 14 days of its merge, or the run was abandoned before it opened one.",
};

/** The text each kind's card writes from the catalogue; the rest show the detector's text. */
const WRITTEN: Partial<Record<Twelve, string>> = {
  spin_loops:
    "reviewer ran the same call 20 or more times in a row with an unchanged result. 7 turns on 3 runs made only those repeats. The round trips cost $2.50.",
  duplicate_tool_calls:
    "reviewer repeated tool calls that had already returned the same result in the run. 7 turns on 3 runs made only those repeats. The round trips cost $2.50.",
  repeated_shell_commands:
    "Agents re-ran shell commands that had already returned the same result in the run. 7 turns on 3 runs made only those repeats. The round trips cost $2.50.",
  spend_with_no_outcome:
    "Ana Ruiz spent $2.50 on 3 runs that ended with nothing kept.",
};

function findingOf(
  kind: Twelve,
  over: Partial<SpendFinding> = {},
): SpendFinding {
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
    runs: 3,
    calls: 7,
    ...over,
  };
}

const ALL = TWELVE.map((kind) =>
  kind === "spend_with_no_outcome"
    ? findingOf(kind, { level: "operator", subject: "prn_ana" })
    : kind === "repeated_shell_commands"
      ? findingOf(kind, { level: "tool", subject: "Bash" })
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

/** Shows all twelve cards: the first page holds ten. */
async function showAll(user: ReturnType<typeof userEvent.setup>) {
  await pickOption(user, screen.getByRole("combobox", { name: "Rows" }), "25");
  await waitFor(() => {
    expect(document.querySelectorAll("li[data-finding]")).toHaveLength(12);
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

afterEach(async () => {
  if (document.body.childElementCount > 0) await expectNoAxe(document.body);
  cleanup();
});

describe("Detector cards", () => {
  it("renders each of the twelve kinds' finding text with its values", async () => {
    const user = userEvent.setup();
    list(ALL);
    await showAll(user);
    for (const kind of TWELVE) {
      const text = card(findingOf(kind).id).querySelector(
        "[data-finding-text]",
      );
      const written = WRITTEN[kind];
      if (written === undefined) {
        expect(text?.getAttribute("data-finding-text")).toBe("detector");
        expect(text).toHaveTextContent(WHY[kind]);
      } else {
        expect(text?.getAttribute("data-finding-text")).toBe("catalogue");
        expect(text).toHaveTextContent(written);
      }
    }
  });

  it("writes one run and one turn in the singular", () => {
    list([
      findingOf("spin_loops", { runs: 1, calls: 1 }),
      findingOf("spend_with_no_outcome", { runs: 1, calls: 1 }),
    ]);
    expect(card("fnd_spinloops")).toHaveTextContent(
      "1 turn on 1 run made only those repeats.",
    );
    expect(card("fnd_spendwithnooutcome")).toHaveTextContent(
      "reviewer spent $2.50 on 1 run that ended with nothing kept.",
    );
  });

  it("leads each card with its amount and its share of the workspace's spend, side by side", async () => {
    const user = userEvent.setup();
    list(ALL);
    await showAll(user);
    for (const finding of ALL) {
      const li = card(finding.id);
      const figures = li.querySelector('[data-testid="finding-figures"]');
      const text = li.querySelector("[data-finding-text]");
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
    expect(fit.querySelector("[data-finding-text]")).toHaveTextContent(
      "Repriced from Opus 5.5 to Sonnet 5",
    );
    // A measured kind carries no estimate label.
    const spin = card("fnd_spinloops");
    expect(spin.querySelector('[data-badge="estimated"]')).toBeNull();
    expect(within(spin).getByText("Amount at stake")).toBeInTheDocument();
  });

  it("says Needs prompt text on a digest_only workspace and shows the whole-prompt repeats", () => {
    const digestOnly = findingOf("repeated_instructions", {
      why: "Runs received the same prompt 7 times this month, across 3 runs. Needs prompt text: this workspace keeps only a digest of each prompt, so the sentences that repeat cannot be shown.",
    });
    list([digestOnly]);
    const li = card("fnd_repeatedinstructions");
    expect(
      li.querySelector('[data-badge="needs-prompt-text"]'),
    ).toHaveTextContent("Needs prompt text");
    expect(li.querySelector("[data-finding-text]")).toHaveTextContent(
      "Runs received the same prompt 7 times this month, across 3 runs.",
    );
  });

  it("shows no Needs prompt text where the workspace keeps prompt text (negative)", () => {
    list([findingOf("repeated_instructions")]);
    const li = card("fnd_repeatedinstructions");
    expect(li.querySelector('[data-badge="needs-prompt-text"]')).toBeNull();
    expect(li.querySelector("[data-finding-text]")).toHaveTextContent(
      'Runs received "Run the tests before you open a pull request" 7 times this month.',
    );
  });

  it("names standing context's weekly price per 1,000 tokens after the share, as not recorded", () => {
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
    expect(
      figure(li, "unit")?.querySelector('[data-recorded="false"]'),
    ).not.toBeNull();
    // A detector that names no per-unit price shows none.
    expect(figure(card("fnd_spinloops"), "unit")).toBeNull();
  });

  it("draws the generic card for a kind with no card of its own", () => {
    // A kind a later lane adds, with the label and definition that lane
    // writes. The contract here does not list the kind yet, so the test sets
    // it on the record the way a wider contract would deliver it.
    const later = findingOf("spin_loops", {
      id: "fnd_retry",
      why: "On 2 runs, a call failed the same way 3 times in a row.",
    });
    Reflect.set(later, "kind", "retry_loops");
    const { spend } = messages;
    const withLater = {
      ...messages,
      spend: {
        ...spend,
        findings: {
          ...spend.findings,
          kind: { ...spend.findings.kind, retry_loops: "Retry loops" },
          kindDefinition: {
            ...spend.findings.kindDefinition,
            retry_loops:
              "The same call failed the same way 3 or more times in a row.",
          },
        },
      },
    };
    list([later], SPEND, (node) => (
      <NextIntlClientProvider locale="en" messages={withLater} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    ));
    const li = card("fnd_retry");
    expect(
      within(li).getByRole("heading", { name: "Retry loops" }),
    ).toBeInTheDocument();
    expect(li.querySelector("[data-finding-text]")).toHaveTextContent(
      "On 2 runs, a call failed the same way 3 times in a row.",
    );
    expect(figure(li, "amount")).toHaveTextContent("$2.50");
    expect(figure(li, "share")).toHaveTextContent("2.5%");
    expect(figure(li, "unit")).toBeNull();
    expect(li.querySelector("[data-badge]")).toBeNull();
  });
});
