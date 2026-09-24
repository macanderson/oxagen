// @vitest-environment jsdom
// The Overview tab drawn on its own (overview.tsx), for the states the page
// test in agent.test.tsx does not reach: a rollup that could not be read, a
// row with no cost or no input, each health verdict, a composition whose
// steering, belt, mandates or operator are missing or unreadable, and a
// definition that is not committed. Every missing figure says "not recorded"
// rather than drawing a zero. Axe runs after every test (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  agentDetail,
  committedDefinition,
  incident,
  incidentPage,
  runRow,
  spendReport,
  spendRow,
  steeringDeliveries,
  toolbelt,
} from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { Overview } = await import("./overview");

type Props = ComponentProps<typeof Overview>;

const PLACE = { org: "acme", ws: "core-platform", agent: "release-bot" };

function renderOverview(overrides: Partial<Props> = {}) {
  const row = spendRow();
  const props: Props = {
    detail: agentDetail({ definition: committedDefinition() }),
    toolbelt: readOk(toolbelt()),
    mandates: mandateList([]),
    incidents: incidentPage([]),
    deliveries: steeringDeliveries(),
    spend: spendReport([row]),
    spendRow: row,
    lastRun: runRow(),
    operatorName: "Marcus Bell",
    place: PLACE,
    ...overrides,
  };
  render(
    <IntlProvider>
      <Overview {...props} />
    </IntlProvider>,
  );
}

const region = (name: string) => screen.getByRole("region", { name });
const health = () =>
  within(region("Composition")).getByText(
    (_, el) => el?.hasAttribute("data-health") ?? false,
  );
const tile = (title: string) => {
  const found = screen
    .getAllByTestId("tile")
    .find((dl) => dl.querySelector("dt")?.textContent === title);
  if (found === undefined) throw new Error(`no tile ${title}`);
  return found;
};

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Overview › 30-day token use", () => {
  it("names the failed rollup read in its panel and draws no figure (negative)", () => {
    renderOverview({
      spend: readError("clickhouse_unavailable", 503),
      spendRow: null,
    });
    const panel = region("30-day token use");
    expect(panel).toHaveTextContent(
      "30-day token use could not be loaded: the control plane answered clickhouse_unavailable.",
    );
    expect(screen.queryByTestId("token-badge")).toBeNull();
    // Last 30 days reads the same row, so it has no figure either.
    expect(tile("Runs")).toHaveTextContent("not recorded");
    expect(tile("Tokens")).toHaveTextContent("not recorded");
    expect(tile("Tokens")).toHaveTextContent("cache read not recorded");
  });

  it("says the cost and its basis are not recorded when the row carries no cost (negative)", () => {
    const row = spendRow({ cost: null });
    renderOverview({ spend: spendReport([row]), spendRow: row });
    expect(screen.getByTestId("token-badge")).toHaveTextContent(
      "6,000 tok · cost not recorded · basis not recorded",
    );
    const panel = region("30-day token use");
    expect(panel).toHaveTextContent("Per run1,500 tok · cost not recorded");
    expect(panel).toHaveTextContent("Basisnot recorded");
    expect(tile("Spend")).toHaveTextContent("not recorded");
    expect(tile("Spend")).toHaveTextContent("basis not recorded");
  });

  it("prints the per-run cost from the row's own cost over its runs", () => {
    renderOverview();
    // $12.50 over 4 runs is $3.125; the Money formatter prints it as $3.12.
    expect(region("30-day token use")).toHaveTextContent(
      "Per run1,500 tok · $3.12",
    );
  });

  it("draws zero shares and no rates for a row that counted no input, run or call (negative)", () => {
    const row = spendRow({
      runs: 0,
      calls: 0,
      tokens: {
        input_uncached: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        output: 0,
        reasoning: 0,
      },
    });
    renderOverview({ spend: spendReport([row]), spendRow: row });
    const classes = within(screen.getByTestId("token-classes")).getAllByRole(
      "listitem",
    );
    expect(classes[6]).toHaveTextContent("Output0 · 0%");
    const panel = region("30-day token use");
    expect(panel).toHaveTextContent("Cache hit ratenot recorded");
    expect(panel).toHaveTextContent("Per runnot recorded");
    expect(panel).toHaveTextContent("Per model callnot recorded");
    expect(tile("Tokens")).toHaveTextContent("cache read not recorded");
  });
});

describe("Overview › health verdict", () => {
  it("is not enrolled for a registered agent with no host and no enrollment", () => {
    renderOverview({
      detail: agentDetail({ identity: { status: "unenrolled" }, hosts: [] }),
      lastRun: null,
    });
    expect(health()).toHaveAttribute("data-health", "notEnrolled");
    expect(health()).toHaveTextContent("not enrolled");
    expect(tile("Tamper incidents")).toHaveTextContent(
      "no hook is installed, so its runs are recorded only",
    );
  });

  it("is no frame yet for an enrolled agent with no run on the page", () => {
    renderOverview({ lastRun: null });
    expect(health()).toHaveAttribute("data-health", "noFrame");
    expect(tile("Runs")).toHaveTextContent("no run on the newest page of runs");
  });

  it("is observe when the newest run recorded the observe tier", () => {
    renderOverview({ lastRun: runRow({ enforcementTier: "observe" }) });
    expect(health()).toHaveAttribute("data-health", "observe");
    expect(tile("Tamper incidents")).toHaveTextContent(
      "enrolled, and nothing is delivered or refused yet",
    );
  });

  it("is healthy when a resolved tamper incident is the only one", () => {
    renderOverview({
      incidents: incidentPage([
        incident({ resolvedAt: "2026-09-14T11:00:00.000Z" }),
      ]),
    });
    expect(health()).toHaveAttribute("data-health", "healthy");
    // The figure counts every tamper incident on the page; the verdict counts the open ones.
    expect(tile("Tamper incidents")).toHaveTextContent("1");
  });

  it("says the tamper figure is not recorded when the incidents could not be read (negative)", () => {
    renderOverview({ incidents: readError("tacho_unavailable", 503) });
    expect(tile("Tamper incidents")).toHaveTextContent("not recorded");
    expect(health()).toHaveAttribute("data-health", "healthy");
  });
});

describe("Overview › composition", () => {
  it("names what is missing when the steering, belt and mandates were not read (negative)", () => {
    renderOverview({
      deliveries: null,
      toolbelt: readError("toolbelt_unavailable", 503),
      mandates: readError("mandates_unavailable", 503),
    });
    const composition = region("Composition");
    expect(composition).toHaveTextContent("no steering manifest is recorded");
    expect(composition).toHaveTextContent(
      "steering is a workspace library; this agent holds a reference, never a copy",
    );
    expect(composition).toHaveTextContent("the belt could not be read");
    expect(composition).toHaveTextContent("1 role · mandates not readable");
  });

  it("finds no manifest when the deliveries read failed or name another agent (negative)", () => {
    renderOverview({ deliveries: readError("steering_unavailable", 503) });
    expect(region("Composition")).toHaveTextContent(
      "no steering manifest is recorded",
    );
    cleanup();
    renderOverview({
      deliveries: steeringDeliveries([{ agentKey: "acme.core.other-bot" }]),
    });
    expect(region("Composition")).toHaveTextContent(
      "no steering manifest is recorded",
    );
  });

  it("draws no principal and no manifest for an identity with no key or principal (negative)", () => {
    renderOverview({
      detail: agentDetail({ identity: { agentKey: null, principalId: null } }),
    });
    const composition = region("Composition");
    expect(composition).toHaveTextContent("Identitynot recorded");
    expect(composition).toHaveTextContent("no steering manifest is recorded");
  });

  it("names the owner by id when no run names them, and says not recorded when no owner is recorded", () => {
    renderOverview({ operatorName: null });
    expect(region("Composition")).toHaveTextContent("Ownerusr_marcusbell");
    cleanup();
    renderOverview({
      operatorName: null,
      detail: agentDetail({ identity: { operatorId: null } }),
    });
    expect(region("Composition")).toHaveTextContent("Ownernot recorded");
  });

  it("draws the host without a tier badge when no run recorded one, and no host line when none is enrolled", () => {
    renderOverview({ lastRun: null });
    const composition = region("Composition");
    expect(composition).toHaveTextContent("build-01");
    expect(composition).toHaveTextContent("linux · bundle mode enforce");
    expect(within(composition).queryByText("harness")).toBeNull();
    cleanup();
    renderOverview({ detail: agentDetail({ hosts: [] }) });
    expect(region("Composition")).toHaveTextContent("no host is enrolled");
  });

  it("counts the mandates the agent holds", () => {
    renderOverview({ mandates: mandateList([mandateRow()]) });
    expect(region("Composition")).toHaveTextContent("1 role · 1 mandate");
  });
});

describe("Overview › definition in git", () => {
  it("names the path the file will take and nothing else when no definition is committed (negative)", () => {
    renderOverview({ detail: agentDetail({ definition: null }) });
    const git = region("Definition in git");
    expect(git).toHaveTextContent("Path.oxagen/agents/release-bot.toml");
    expect(git).toHaveTextContent("Repono definition is committed yet");
    expect(git).toHaveTextContent("Commitnot recorded");
    expect(git).toHaveTextContent("definition_digestnot recorded");
  });

  it("prints the branch alone when the pull request URL names no GitHub repository", () => {
    renderOverview({
      detail: agentDetail({
        definition: {
          ...committedDefinition(),
          pullRequestUrl: "https://git.example.com/acme/core/merge_requests/3",
        },
      }),
    });
    const git = region("Definition in git");
    expect(git).toHaveTextContent("Repoagents/release-bot");
    expect(git).not.toHaveTextContent("acme/core @");
  });

  it("names the generated subagent file for a harness that reads one, and none for Codex", () => {
    renderOverview();
    expect(region("Definition in git")).toHaveTextContent("release-bot.md");
    cleanup();
    renderOverview({
      detail: agentDetail({
        identity: { harness: "codex" },
        definition: committedDefinition(),
      }),
    });
    expect(region("Definition in git")).toHaveTextContent(
      "none: this harness reads no generated subagent file",
    );
  });
});
