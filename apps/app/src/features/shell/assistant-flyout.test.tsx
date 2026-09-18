// @vitest-environment jsdom
// The assistant flyout over a fake turn action: that it asks and shows the
// reply, carries the conversation across turns, names the run each turn was
// recorded as, surfaces parked writes rather than swallowing them, reads each
// refusal, offers no composer outside a workspace, and keeps the transcript to
// the workspace it was asked in.
//
// The flyout WL-06 deleted had a `disabled` textarea, so the assertion that
// earns this file is the first one: a composer that reaches ask_assistant.
import { act, cleanup, render, screen } from "@testing-library/react";
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
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
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
const tree = () => (
  <IntlProvider>
    <ShellStateProvider>
      <OpenIt />
      <AssistantFlyout />
    </ShellStateProvider>
  </IntlProvider>
);

async function openFlyout() {
  const user = userEvent.setup();
  const { rerender } = render(tree());
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  /** Move to another page, the way a navigation does under the persistent shell. */
  const renavigate = (to: string) => {
    pathname.mockReturnValue(to);
    rerender(tree());
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
    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
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

  // `usePathname()` drops the query string, and Spend and Steering keep the
  // record on screen there rather than in a path segment (`shared/safe-path.ts`
  // mints `?finding=` and `?proposal=`). Without these the agent is asked
  // about "this finding" with no indication of which one.
  it.each([
    {
      page: "a finding on Spend",
      url: "/acme/core-platform/spend?tab=findings&finding=fnd_014",
      route: "spend",
      entityId: "fnd_014",
    },
    {
      page: "a key's drill on Spend",
      url: "/acme/core-platform/spend?tab=keys&drill=key_88",
      route: "spend",
      entityId: "key_88",
    },
    {
      page: "a proposal on Steering",
      url: "/acme/core-platform/steering?tab=proposals&proposal=prp_7",
      route: "steering",
      entityId: "prp_7",
    },
  ])("carries the record a query value selects on $page", async (view) => {
    pathname.mockReturnValue(view.url);
    const { user } = await openFlyout();
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: view.route,
      entityId: view.entityId,
    });
  });

  // An allow-list, not a pass-through: the query string is whatever the address
  // bar says, so a value no route asked for is not page context.
  it("carries no record for a query value no route names (negative)", async () => {
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

  // A key present but empty is a cleared selection — Spend leaves `?finding=`
  // behind when the finding is closed — so the next key is what is on screen.
  it("reads past a query value that names nothing to the one that does", async () => {
    pathname.mockReturnValue(
      "/acme/core-platform/spend?tab=keys&finding=&drill=key_88",
    );
    const { user } = await openFlyout();
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "spend",
      entityId: "key_88",
    });
  });

  // `entityId` is capped at 256 characters by `assistantPageContextSchema`; a
  // longer one is no id, and sending it would refuse the whole turn for being
  // invalid rather than answer the question without it.
  it("drops a record id longer than the contract accepts rather than refusing the turn (negative)", async () => {
    pathname.mockReturnValue(
      `/acme/core-platform/steering?proposal=${"p".repeat(257)}`,
    );
    const { user } = await openFlyout();
    await ask(user, "explain this");

    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      route: "steering",
      entityId: null,
    });
  });

  // Register an agent is the route where the path segment is the *step* and the
  // record is in the query: `routes.register` mints `/register/wrap?agent=…`.
  // Without its row, "why has this agent not enrolled?" sent `entityId: "wrap"`.
  it.each(["wrap", "run"])(
    "carries the agent being registered, not the %s step it is on",
    async (step) => {
      pathname.mockReturnValue(
        `/acme/core-platform/register/${step}?agent=agt_31`,
      );
      const { user } = await openFlyout();
      await ask(user, "why has this not enrolled?");

      expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
        route: "register",
        entityId: "agt_31",
      });
    },
  );

  // A query value on a route that keeps its record in the path is not the
  // record: the table decides which half of the URL is read.
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

  // The Run page reads nothing until WL-35 builds it, and `get_run` declares
  // no `app` layer, so a link here would advertise evidence that does not
  // exist — and this is the one surface where the link would be the whole
  // claim, because the run is excluded from every list. The id is the handle
  // that reaches `get_run` on the API, MCP and CLI surfaces, which are built.
  it("does not link the run while the Run page reads nothing (negative)", async () => {
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    const line = await screen.findByTestId("assistant-recorded-as");
    expect(line).toHaveTextContent("arun_01k9");
    expect(line.querySelector("a")).toBeNull();
    expect(
      screen.getByTestId("assistant-answer").querySelector("a"),
    ).toBeNull();
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

  it("drops a reply that lands after the person has left the workspace it was asked in (negative)", async () => {
    let settle: (turn: unknown) => void = () => undefined;
    askAssistant.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { user, renavigate } = await openFlyout();
    await ask(user, "what is live?");
    expect(screen.getByTestId("assistant-thinking")).toBeTruthy();

    renavigate("/acme/payments");
    settle(turn({ reply: "core-platform is live." }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("assistant-answer")).toBeNull();
    expect(screen.queryByText("core-platform is live.")).toBeNull();
    // …and the composer is not left waiting on a turn that will never show.
    expect(screen.queryByTestId("assistant-thinking")).toBeNull();
    expect(screen.getByTestId("assistant-composer")).not.toBeDisabled();
  });

  // "acme/core-platform" names a place; two visits to it are two occasions.
  // A guard that compares the place lets a turn from the first visit land in
  // the transcript the second visit just cleared, so the reply, the run link
  // and the conversation id all belong to a conversation that is gone.
  it("does not resurrect a turn from an earlier visit when the person goes away and comes back (negative)", async () => {
    let settle: (turn: unknown) => void = () => undefined;
    askAssistant.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { user, renavigate } = await openFlyout();
    await ask(user, "what is live?");

    renavigate("/acme/payments");
    renavigate("/acme/core-platform");
    settle(turn({ reply: "an answer from the first visit." }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("assistant-answer")).toBeNull();
    expect(screen.queryByText("an answer from the first visit.")).toBeNull();
    expect(screen.getByTestId("assistant-intro")).toBeTruthy();

    // …and the conversation it would have opened is not carried either.
    askAssistant.mockResolvedValue(turn());
    await ask(user, "second");
    expect(askAssistant.mock.calls[1]?.[2]).toMatchObject({
      conversationId: null,
    });
  });

  // The guard above is a generation and nothing more, which is only sound
  // because one generation holds at most one turn in flight. This is that
  // premise: drop the `pending` gate and the conversation id has two writers.
  it("refuses a second question while a turn is in flight (negative)", async () => {
    askAssistant.mockReturnValue(new Promise(() => undefined));
    const { user } = await openFlyout();
    await ask(user, "first");

    expect(screen.getByTestId("assistant-composer")).toBeDisabled();
    await user.type(screen.getByTestId("assistant-composer"), "second");
    await user.click(screen.getByTestId("assistant-send"));
    expect(askAssistant).toHaveBeenCalledTimes(1);
  });

  // A workspace change clears `pending`, so a person who comes back can ask
  // again before the first turn resolves. The newest owns the transcript; the
  // older belongs to an earlier generation and is discarded.
  it("lets the newest turn own the conversation when an older one is still in flight (negative)", async () => {
    let settleFirst: (turn: unknown) => void = () => undefined;
    askAssistant.mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      }),
    );
    const { user, renavigate } = await openFlyout();
    await ask(user, "first");

    // Away and back: the transcript is cleared and the composer is live again.
    renavigate("/acme/payments");
    renavigate("/acme/core-platform");
    askAssistant.mockResolvedValue(
      turn({
        conversationId: "6f1f5a8e-0000-4000-8000-00000000c0df",
        reply: "the second answer.",
      }),
    );
    await ask(user, "second");
    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "the second answer.",
    );

    settleFirst(turn({ reply: "the first answer." }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("the first answer.")).toBeNull();
    expect(screen.getAllByTestId("assistant-answer")).toHaveLength(1);
    await ask(user, "third");
    expect(askAssistant.mock.calls[2]?.[2]).toMatchObject({
      conversationId: "6f1f5a8e-0000-4000-8000-00000000c0df",
    });
  });

  // The window between two moments React does not make adjacent: the
  // workspace-change render commits — the transcript is already gone from the
  // screen — and React flushes that render's passive effects a task later. A
  // turn that resolves in between reads whatever the request guard holds, so a
  // guard carried by `useEffect` still names the workspace the person left,
  // and the reply, the run and the conversation id land in the transcript the
  // switch had just cleared. Reproducing it needs the real scheduler: `act`,
  // which every other test here runs inside, flushes passive effects with the
  // commit and closes the window by hand, so this one drives its own root.
  it("drops a reply that resolves after the workspace-change render commits but before its effects run (negative)", async () => {
    let settle: (turn: unknown) => void = () => undefined;
    askAssistant.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
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

      // Out of `act`, so React schedules the passive effects the way a browser
      // does rather than flushing them as part of the commit.
      IS_REACT_ACT_ENVIRONMENT = false;
      pathname.mockReturnValue("/acme/payments");
      root.render(tree());
      await tick();
      // Committed: payments is on screen and core-platform's transcript is gone…
      expect(screen.queryByTestId("assistant-log")).toBeNull();
      // …and this is the window, before the effect that used to be the only
      // thing carrying the new generation into the request guard.
      settle(turn({ reply: "core-platform is live." }));
      await tick();
      await tick();

      expect(screen.queryByTestId("assistant-answer")).toBeNull();
      expect(screen.queryByText("core-platform is live.")).toBeNull();
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

  it("has no axe violations", async () => {
    const { flyout } = await openFlyout();
    await expectNoAxe(flyout);
  });
});
