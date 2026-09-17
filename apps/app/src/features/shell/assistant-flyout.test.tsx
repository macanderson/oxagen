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

const pathname = vi.fn(() => "/acme/core-platform");
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
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

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
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

  it("has no axe violations", async () => {
    const { flyout } = await openFlyout();
    await expectNoAxe(flyout);
  });
});
