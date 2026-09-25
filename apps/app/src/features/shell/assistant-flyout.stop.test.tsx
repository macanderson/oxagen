// @vitest-environment jsdom
// The flyout's Stop control (#4164). While a turn runs, the composer's button
// is Stop, and a press posts the turn's id to the workspace's stop route. The
// turn then comes back with whatever it had written, marked Stopped. While an
// answer types itself out, Stop keeps what is already on screen. Closing the
// flyout stops nothing (ADR-092, #3292).
//
// The turn action, the thread read and `fetch` are fakes. Which turn the
// server stops, and that its run records cancelled, is proved where the turn
// runs: `packages/agent/src/handlers/assistant.ask.stop.test.ts` and
// `packages/agent/src/runtime/assistant-turn.test.ts`.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { ShellStateProvider, useShellState } from "./shell-state";

const askAssistant = vi.fn();
vi.mock("./assistant-actions", () => ({ askAssistant }));
const loadAssistantThread = vi.fn();
vi.mock("./assistant-thread-actions", () => ({ loadAssistantThread }));
vi.mock("./assistant-parked-approvals", () => ({
  AssistantParkedApprovals: () => null,
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");

const fetchStop = vi.fn<typeof fetch>();

const turn = (over: Record<string, unknown> = {}) => ({
  ok: true,
  value: {
    conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
    conversationPublicId: "cnv_01k9c0de",
    userMessageId: "6f1f5a8e-0000-4000-8000-00000000a001",
    assistantMessageId: "6f1f5a8e-0000-4000-8000-00000000a002",
    runId: "arun_01ka",
    reply: "Two agents are idle.",
    parkedCards: [],
    ...over,
  },
});

/** A turn that runs until the test ends it. */
function heldTurn() {
  let end: (value: unknown) => void = () => undefined;
  askAssistant.mockReturnValue(
    new Promise((resolve) => {
      end = resolve;
    }),
  );
  return {
    end: async (value: unknown) => {
      await act(async () => {
        end(value);
        await Promise.resolve();
      });
    },
  };
}

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

const tree = (): ReactNode => (
  <IntlProvider>
    <ShellStateProvider>
      <OpenIt />
      <AssistantFlyout />
    </ShellStateProvider>
  </IntlProvider>
);

async function openFlyout() {
  const user = userEvent.setup();
  render(tree());
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  // The thread read settles first, so the question below is not refused as
  // "still loading".
  await waitFor(() => {
    expect(loadAssistantThread).toHaveBeenCalled();
  });
  return user;
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(await screen.findByTestId("assistant-composer"), text);
  await user.click(await screen.findByTestId("assistant-send"));
}

/** The `turnId` field of an object, or undefined when it has none. */
function turnIdIn(value: unknown): unknown {
  return typeof value === "object" && value !== null && "turnId" in value
    ? value.turnId
    : undefined;
}

/** The turn id the flyout minted and handed the question. */
function askedTurnId(): string {
  const input: unknown = askAssistant.mock.calls[0]?.[2];
  const turnId = turnIdIn(input);
  if (typeof turnId !== "string") throw new Error("no turnId was asked");
  return turnId;
}

/** A stop the flyout posted: its path and the turn id in its body. */
function postedStop(call = 0): { path: string; turnId: unknown } {
  const posted = fetchStop.mock.calls[call];
  if (posted === undefined) {
    throw new Error(`no stop was posted at ${String(call)}`);
  }
  const [url, init] = posted;
  if (typeof url !== "string" || typeof init?.body !== "string") {
    throw new Error("the stop was not a path and a JSON body");
  }
  expect(init.method).toBe("POST");
  const body: unknown = JSON.parse(init.body);
  return { path: url, turnId: turnIdIn(body) };
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal("fetch", fetchStop);
});

beforeEach(() => {
  askAssistant.mockReset();
  loadAssistantThread.mockReset();
  fetchStop.mockReset();
  refresh.mockReset();
  askAssistant.mockResolvedValue(turn());
  loadAssistantThread.mockResolvedValue({
    ok: true,
    value: {
      workspaceKey: "7b000000-0000-4000-8000-000000000001",
      thread: null,
    },
  });
  fetchStop.mockResolvedValue(Response.json({ turnId: "t", found: true }));
});
afterEach(cleanup);

describe("Stop while a turn runs", () => {
  it("replaces Send while the turn runs, on the same button, so focus stays on it", async () => {
    heldTurn();
    const user = await openFlyout();
    await ask(user, "what is live?");

    const stop = await screen.findByTestId("assistant-stop");
    expect(stop).toHaveAccessibleName("Stop");
    expect(screen.queryByTestId("assistant-send")).toBeNull();
    // user.click focused Send; the node that had focus is now Stop.
    expect(document.activeElement).toBe(stop);
    await expectNoAxe(screen.getByTestId("assistant-flyout"));
  });

  it("stops a turn before its first word and keeps nothing but the mark", async () => {
    const held = heldTurn();
    const user = await openFlyout();
    await ask(user, "what is live?");
    await user.click(await screen.findByTestId("assistant-stop"));

    expect(fetchStop).toHaveBeenCalledTimes(1);
    expect(postedStop()).toEqual({
      path: "/acme/core-platform/assistant/stop",
      turnId: askedTurnId(),
    });
    // The stop is on its way: a second press sends nothing.
    expect(screen.getByTestId("assistant-stop")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByTestId("assistant-stop"));
    expect(fetchStop).toHaveBeenCalledTimes(1);

    await held.end(turn({ reply: "", stopped: true }));

    expect(await screen.findByTestId("assistant-stopped")).toHaveTextContent(
      "Stopped",
    );
    expect(screen.getByTestId("assistant-recorded-as")).toHaveTextContent(
      "recorded as arun_01ka",
    );
    // A stopped answer does not type itself out, so the turn is over and the
    // button is Send again.
    expect(await screen.findByTestId("assistant-send")).toBeTruthy();
    expect(screen.queryByTestId("assistant-stop")).toBeNull();
  });

  it("keeps the words a turn stopped mid-reply had written, whole and marked", async () => {
    const held = heldTurn();
    const user = await openFlyout();
    await ask(user, "what is live?");
    await user.click(await screen.findByTestId("assistant-stop"));
    await held.end(turn({ reply: "Two agents are", stopped: true }));

    const answer = await screen.findByTestId("assistant-answer");
    expect(answer).toHaveTextContent("Two agents are");
    expect(screen.getByTestId("assistant-stopped")).toBeTruthy();
    // Painted whole: nothing about it is still revealing.
    expect(answer.querySelector("[inert]")).toBeNull();
    expect(screen.queryByTestId("assistant-answer-announced")).toBeNull();
  });

  // A write that parked for approval before the stop is still on the record,
  // waiting for a decision, so the stopped answer says so.
  it("stops a turn during a tool call and still shows the write it parked", async () => {
    const held = heldTurn();
    const user = await openFlyout();
    await ask(user, "raise the budget");
    await user.click(await screen.findByTestId("assistant-stop"));
    await held.end(
      turn({
        reply: "",
        stopped: true,
        parkedCards: [
          {
            approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
            capability: "set_budget",
            expiresAt: "2026-09-25T10:05:00.000Z",
          },
        ],
      }),
    );

    expect(await screen.findByTestId("assistant-stopped")).toBeTruthy();
    expect(screen.getByTestId("assistant-parked")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says so when the stop fails and lets the person press Stop again (negative)", async () => {
    fetchStop.mockResolvedValueOnce(
      Response.json({ code: "unavailable" }, { status: 503 }),
    );
    fetchStop.mockRejectedValueOnce(new TypeError("offline"));
    const held = heldTurn();
    const user = await openFlyout();
    await ask(user, "what is live?");

    await user.click(await screen.findByTestId("assistant-stop"));
    expect(
      await screen.findByTestId("assistant-stop-failed"),
    ).toHaveTextContent(
      "stella could not stop this turn, so it is still running. Try Stop again.",
    );
    expect(screen.getByTestId("assistant-stop")).not.toHaveAttribute(
      "aria-disabled",
    );

    // A stop that never reaches the server fails the same way.
    await user.click(screen.getByTestId("assistant-stop"));
    await waitFor(() => {
      expect(fetchStop).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByTestId("assistant-stop-failed")).toBeTruthy();

    await user.click(screen.getByTestId("assistant-stop"));
    await waitFor(() => {
      expect(screen.queryByTestId("assistant-stop-failed")).toBeNull();
    });
    expect(fetchStop).toHaveBeenCalledTimes(3);
    expect(postedStop(2).turnId).toBe(askedTurnId());

    await held.end(turn({ reply: "", stopped: true }));
    expect(await screen.findByTestId("assistant-stopped")).toBeTruthy();
  });

  it("stops nothing when the person closes the flyout mid-turn (negative)", async () => {
    const held = heldTurn();
    const user = await openFlyout();
    await ask(user, "what is live?");
    await screen.findByTestId("assistant-stop");

    await user.click(screen.getByRole("button", { name: "Close stella" }));
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    // Still running, so still Stop.
    expect(await screen.findByTestId("assistant-stop")).toBeTruthy();
    await held.end(turn());

    expect(await screen.findByTestId("assistant-answer")).toBeTruthy();
    expect(screen.queryByTestId("assistant-stopped")).toBeNull();
    expect(fetchStop).not.toHaveBeenCalled();
  });
});

describe("Stop while an answer types itself out", () => {
  // The frames are run by hand, so the answer is caught part way through.
  let frames: FrameRequestCallback[] = [];
  const step = (ts: number) => {
    const due = frames;
    frames = [];
    act(() => {
      for (const frame of due) frame(ts);
    });
  };

  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frames.push(frame);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const LONG =
    "Three runs are live. The first is a nightly backfill that has read four of its nine tables. The second is a review of the billing change. The third is waiting on an approval that expires at ten.";

  it("freezes the answer at what is on screen and marks it, without asking the server", async () => {
    askAssistant.mockResolvedValue(turn({ reply: LONG }));
    const user = await openFlyout();
    await ask(user, "what is live?");
    await screen.findByTestId("assistant-answer");

    // The turn is over, and its answer is still typing out: Stop shows.
    step(1000);
    step(1016);
    const stop = await screen.findByTestId("assistant-stop");
    const shown = screen
      .getByTestId("assistant-answer")
      .querySelector("[inert]")?.textContent;
    expect(shown?.length).toBeGreaterThan(0);
    expect(shown?.length).toBeLessThan(LONG.length);

    await user.click(stop);

    const answer = screen.getByTestId("assistant-answer");
    expect(answer).toHaveTextContent(shown ?? "");
    expect(answer.textContent).not.toContain("expires at ten");
    expect(screen.getByTestId("assistant-stopped")).toBeTruthy();
    expect(await screen.findByTestId("assistant-send")).toBeTruthy();
    // The frames that were due draw nothing more.
    step(1032);
    expect(screen.getByTestId("assistant-answer").textContent).not.toContain(
      "expires at ten",
    );
    // The turn had already ended, so there was nothing on the server to stop.
    expect(fetchStop).not.toHaveBeenCalled();
  });

  it("is Send again once the answer has typed out whole (negative)", async () => {
    askAssistant.mockResolvedValue(turn({ reply: "Two agents are idle." }));
    const user = await openFlyout();
    await ask(user, "what is live?");
    await screen.findByTestId("assistant-stop");

    for (let ts = 1000; frames.length > 0 && ts < 3000; ts += 16) {
      step(ts);
    }

    expect(await screen.findByTestId("assistant-send")).toBeTruthy();
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Two agents are idle.",
    );
    expect(screen.queryByTestId("assistant-stopped")).toBeNull();
  });
});
