// @vitest-environment jsdom
// Suggested questions in the empty flyout: that each page with questions shows
// its own, that a question names the record on screen by its label, that a
// click fills the composer and sends nothing, and that a page with no
// questions, or no workspace, shows none.
//
// The route-to-questions mapping and the label rule are pure functions, so
// they are held here directly as well as through the flyout that renders them.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { recordLabel, suggestionsFor } from "./assistant-suggestions";
import { PageRecord } from "./page-record";
import type { readAssistantReply as ReadAssistantReply } from "./assistant-actions";
import type {
  AssistantQuestion,
  AssistantStreamResult,
} from "./assistant-stream-client";
import { ShellStateProvider, useShellState } from "./shell-state";

// The turn's transport (assistant-stream-client.ts) answers in the shape the
// Server Action it replaced did, so these cases drive it through one fake
// that takes the same three arguments and leaves the stream's handlers out.
// What arrives while a turn streams is assistant-flyout.streaming.test.tsx.
const askAssistant =
  vi.fn<
    (
      org: string,
      ws: string,
      question: AssistantQuestion,
    ) => Promise<AssistantStreamResult>
  >();
vi.mock("./assistant-stream-client", () => ({
  askAssistantStream: (org: string, ws: string, question: AssistantQuestion) =>
    askAssistant(org, ws, question),
}));
vi.mock("./assistant-actions", () => ({
  readAssistantReply: vi.fn<typeof ReadAssistantReply>(),
}));
// The engine read has its own file (assistant-flyout.engine-health.test.tsx).
// Here it never answers, so nothing but a turn in flight holds Send.
vi.mock("./engine-actions", () => ({
  readAssistantEngine: () => new Promise(() => undefined),
}));

const pathname = vi.fn(() => "/acme/core-platform");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");

function OpenIt() {
  const { setAssistantOpen } = useShellState();
  return (
    <button
      type="button"
      onClick={() => {
        setAssistantOpen(true);
      }}
    >
      open assistant
    </button>
  );
}

// `page` sits outside `ShellStateProvider`, where the layout puts the real
// page, which is why a page declares its record through a module store.
async function openFlyout(page?: ReactNode) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AssistantFlyout />
      </ShellStateProvider>
      {page}
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  return { user, flyout: screen.getByTestId("assistant-flyout") };
}

/** The questions on screen, in order. */
function questions(): string[] {
  const list = screen.getByRole("list", { name: "Ask about this page" });
  return within(list)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

beforeAll(() => {
  // The flyout reads its breakpoint as a store; these tests sit above `md`.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  askAssistant.mockReset();
  askAssistant.mockResolvedValue({
    ok: true,
    value: {
      conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
      runId: "arun_01k9",
      reply: "Three runs are live.",
      parkedCards: [],
      stopped: false,
    },
  });
  pathname.mockReturnValue("/acme/core-platform");
});
afterEach(cleanup);

describe("suggestionsFor", () => {
  it.each([
    {
      route: "fleet",
      label: null,
      keys: ["fleet.waiting", "fleet.stopped", "fleet.spend"],
    },
    {
      route: "runs",
      label: "arun_01k9",
      keys: ["run.stopped", "run.cost", "run.denied"],
    },
    {
      route: "spend",
      label: null,
      keys: ["spend.drivers", "spend.operators", "spend.budget"],
    },
    {
      route: "mandates",
      label: "mdt_7",
      keys: ["mandate.allows", "mandate.left", "mandate.expires"],
    },
    { route: "agents", label: null, keys: ["agents.cost", "agents.waiting"] },
    {
      route: "agents",
      label: "e2e-agent",
      keys: ["agent.runs", "agent.cost", "agent.mandate"],
    },
  ])("gives $route with label $label its set", ({ route, label, keys }) => {
    expect(suggestionsFor(route, label)).toEqual(keys);
  });

  // A run and a mandate are always one record. Without its label every
  // question would have a hole where the record's name goes.
  it("gives a run or a mandate without a record nothing (negative)", () => {
    expect(suggestionsFor("runs", null)).toEqual([]);
    expect(suggestionsFor("mandates", null)).toEqual([]);
  });

  it.each(["tools", "steering", "runtimes", "repositories", "register"])(
    "gives %s nothing (negative)",
    (route) => {
      expect(suggestionsFor(route, null)).toEqual([]);
      expect(suggestionsFor(route, "rec_1")).toEqual([]);
    },
  );

  it("offers two or three questions wherever it offers any", () => {
    for (const route of ["fleet", "runs", "spend", "mandates", "agents"])
      for (const label of [null, "rec_1"]) {
        const count = suggestionsFor(route, label).length;
        expect(count === 0 || (count >= 2 && count <= 3)).toBe(true);
      }
  });
});

describe("recordLabel", () => {
  it("names the record by the label its page declared", () => {
    expect(
      recordLabel({ id: "arun_01k9", label: "nightly-sync" }, "arun_01k9"),
    ).toBe("nightly-sync");
  });

  it("falls back to the id when the page declared no label, or a blank one", () => {
    expect(recordLabel({ id: "fnd_014", label: null }, undefined)).toBe(
      "fnd_014",
    );
    expect(recordLabel({ id: "fnd_014", label: "  " }, undefined)).toBe(
      "fnd_014",
    );
  });

  it("reads the path segment when the page declared nothing", () => {
    expect(recordLabel(null, "arun_01k9")).toBe("arun_01k9");
    expect(recordLabel(null, undefined)).toBeNull();
  });

  // The page is right about what it shows. `{ id: null }` says no record,
  // whatever the path segment beside it says.
  it("believes a page that declares no record over the path (negative)", () => {
    expect(recordLabel({ id: null, label: "stale" }, "name")).toBeNull();
  });

  // Past the cap the turn drops the record, so no question may name it.
  it("carries no label past the id cap, and no over-long declared label (negative)", () => {
    expect(recordLabel(null, "r".repeat(257))).toBeNull();
    expect(recordLabel(null, "r".repeat(256))).toBe("r".repeat(256));
    expect(recordLabel({ id: "agt_1", label: "n".repeat(257) }, "agt_1")).toBe(
      "agt_1",
    );
  });
});

describe("suggested questions in the empty flyout", () => {
  it.each([
    {
      page: "Fleet",
      url: "/acme/core-platform",
      shown: [
        "Which approvals are waiting on a person, and which one expires first?",
        "Which runs failed or halted in the last 24 hours, and why?",
        "Which agent spent the most this week, and on what?",
      ],
    },
    {
      page: "Run",
      url: "/acme/core-platform/runs/arun_01k9",
      shown: [
        "Why did run arun_01k9 stop?",
        "What did run arun_01k9 cost, and which model spent the most?",
        "Which tool calls in run arun_01k9 were denied, and by which rule?",
      ],
    },
    {
      page: "Spend",
      url: "/acme/core-platform/spend",
      shown: [
        "Which agents and models drove this month’s spend?",
        "What did each operator spend this month, and on which agents?",
        "Will this workspace stay within its budget this month?",
      ],
    },
    {
      page: "Mandates",
      url: "/acme/core-platform/mandates/mdt_7",
      shown: [
        "What does mandate mdt_7 let its agent do, and what does it route to a person?",
        "How much authority is left on mandate mdt_7 this period?",
        "When does mandate mdt_7 expire, and who granted it?",
      ],
    },
    {
      page: "Agents",
      url: "/acme/core-platform/agents",
      shown: [
        "Which agents cost the most this month?",
        "Which agents have approvals waiting on a person?",
      ],
    },
    {
      page: "one agent",
      url: "/acme/core-platform/agents/e2e-agent/overview",
      shown: [
        "How did e2e-agent’s runs end this week?",
        "What did e2e-agent cost this month, and on which models?",
        "What does e2e-agent’s mandate allow, and how much of it is left?",
      ],
    },
  ])("shows $page its questions", async ({ url, shown }) => {
    pathname.mockReturnValue(url);
    await openFlyout();
    expect(questions()).toEqual(shown);
  });

  it("names the run by the label its page declared, not its id", async () => {
    pathname.mockReturnValue("/acme/core-platform/runs/arun_01k9");
    await openFlyout(
      <PageRecord route="runs" id="arun_01k9" label="nightly-sync" />,
    );
    expect(questions()[0]).toBe("Why did run nightly-sync stop?");
    expect(questions().join(" ")).not.toContain("arun_01k9");
  });

  it("fills the composer with the question, moves focus there, and sends nothing", async () => {
    pathname.mockReturnValue("/acme/core-platform/runs/arun_01k9");
    const { user } = await openFlyout();

    await user.click(
      screen.getByRole("button", { name: "Why did run arun_01k9 stop?" }),
    );

    const composer = screen.getByTestId("assistant-composer");
    expect(composer).toHaveValue("Why did run arun_01k9 stop?");
    expect(composer).toHaveFocus();
    expect(askAssistant).not.toHaveBeenCalled();
    // Nothing was asked, so the thread is still empty and the questions stay.
    expect(screen.queryByTestId("assistant-log")).toBeNull();
    expect(screen.getByTestId("assistant-suggestions")).toBeTruthy();
  });

  it("keeps what the person already typed and puts the question after it", async () => {
    const { user } = await openFlyout();
    await user.type(screen.getByTestId("assistant-composer"), "My question.");

    await user.click(
      screen.getByRole("button", {
        name: "Which agent spent the most this week, and on what?",
      }),
    );

    expect(screen.getByTestId("assistant-composer")).toHaveValue(
      "My question.\n\nWhich agent spent the most this week, and on what?",
    );
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("sends the question only when the person sends it", async () => {
    const { user } = await openFlyout();
    await user.click(
      screen.getByRole("button", {
        name: "Which runs failed or halted in the last 24 hours, and why?",
      }),
    );
    await user.click(screen.getByTestId("assistant-send"));

    expect(askAssistant).toHaveBeenCalledTimes(1);
    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      content: "Which runs failed or halted in the last 24 hours, and why?",
      route: "fleet",
    });
    await screen.findByTestId("assistant-answer");
    // The thread has a turn now, so the empty state and its questions are gone.
    expect(screen.queryByTestId("assistant-suggestions")).toBeNull();
  });

  it.each([
    { page: "Tools", url: "/acme/core-platform/tools" },
    { page: "Steering", url: "/acme/core-platform/steering" },
    { page: "Runtimes", url: "/acme/core-platform/runtimes" },
  ])("shows $page no questions (negative)", async ({ url }) => {
    pathname.mockReturnValue(url);
    await openFlyout();
    expect(screen.getByTestId("assistant-intro")).toBeTruthy();
    expect(screen.queryByTestId("assistant-suggestions")).toBeNull();
  });

  // There is no composer outside a workspace, so there is nothing to fill.
  it("shows no questions outside a workspace (negative)", async () => {
    pathname.mockReturnValue("/acme");
    await openFlyout();
    expect(screen.getByTestId("assistant-needs-workspace")).toBeTruthy();
    expect(screen.queryByTestId("assistant-suggestions")).toBeNull();
  });

  it("has no axe violations with the questions on screen", async () => {
    pathname.mockReturnValue("/acme/core-platform/mandates/mdt_7");
    const { flyout } = await openFlyout();
    expect(screen.getByTestId("assistant-suggestions")).toBeTruthy();
    await expectNoAxe(flyout);
  });
});
