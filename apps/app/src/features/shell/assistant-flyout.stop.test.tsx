// @vitest-environment jsdom
// The flyout's Stop control (#4164). While a turn streams, the composer's
// button is Stop, and a press posts the turn's id to the workspace's stop
// route. The stream then ends with whatever the turn had written, marked
// Stopped. Closing the flyout stops nothing (ADR-092, #3292). A stopped reply
// keeps its mark after a reload.
//
// The stream client (assistant-stream-client.ts), the thread read and `fetch`
// are fakes. The stream client is driven through one fake that takes the
// question and the stream handlers, so a case can write part of a reply
// before the stop. Which turn the
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
import type { AssistantThread } from "@/data/contracts/conversations";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ShellStateProvider, useShellState } from "./shell-state";

const askAssistant = vi.fn();
/** The stream handlers the flyout passed each turn, in order. */
const streamed: Array<{ onText?: (delta: string) => void }> = [];
vi.mock("./assistant-stream-client", () => ({
  askAssistantStream: (
    org: string,
    ws: string,
    question: unknown,
    on: { onText?: (delta: string) => void } = {},
  ): unknown => {
    streamed.push(on);
    return askAssistant(org, ws, question);
  },
}));
vi.mock("./assistant-actions", () => ({ readAssistantReply: vi.fn() }));
const loadAssistantThread = vi.fn();
vi.mock("./assistant-thread-actions", () => ({ loadAssistantThread }));
vi.mock("./assistant-parked-approvals", () => ({
  AssistantParkedApprovals: () => null,
}));

const refresh = vi.fn();
const pathname = vi.fn(() => "/acme/core-platform");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
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
    toolCalls: [],
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
  const { rerender } = render(tree());
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  // The thread read settles first, so the question below is not refused as
  // "still loading".
  await waitFor(() => {
    expect(loadAssistantThread).toHaveBeenCalled();
  });
  /** Move the page to another path, as a client navigation does. */
  const renavigate = (to: string) => {
    pathname.mockReturnValue(to);
    rerender(tree());
  };
  return { user, renavigate };
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

/** The turn id the flyout minted and handed a question, the first by default. */
function askedTurnId(call = 0): string {
  const input: unknown = askAssistant.mock.calls[call]?.[2];
  const turnId = turnIdIn(input);
  if (typeof turnId !== "string") throw new Error("no turnId was asked");
  return turnId;
}

/** The shape of a turn id the flyout mints. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Let a stop the flyout sent come back and settle its state. */
async function settleStop() {
  await waitFor(() => {
    expect(fetchStop).toHaveBeenCalledTimes(1);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

/** Stub `matchMedia`, matching only the queries named. */
function stubMedia(matching: readonly string[] = []) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matching.includes(query),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeAll(() => {
  stubMedia();
  vi.stubGlobal("fetch", fetchStop);
});

beforeEach(() => {
  askAssistant.mockReset();
  streamed.length = 0;
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
  pathname.mockReturnValue("/acme/core-platform");
});
afterEach(cleanup);

describe("Stop while a turn runs", () => {
  it("replaces Send while the turn runs, on the same button, so focus stays on it", async () => {
    heldTurn();
    const { user } = await openFlyout();
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
    const { user } = await openFlyout();
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
    // The stream has ended, so the turn is over and the button is Send again.
    expect(await screen.findByTestId("assistant-send")).toBeTruthy();
    expect(screen.queryByTestId("assistant-stop")).toBeNull();
  });

  it("keeps the words a turn stopped mid-reply had written, whole and marked", async () => {
    const held = heldTurn();
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    await user.click(await screen.findByTestId("assistant-stop"));
    await held.end(turn({ reply: "Two agents are", stopped: true }));

    const answer = await screen.findByTestId("assistant-answer");
    expect(answer).toHaveTextContent("Two agents are");
    expect(screen.getByTestId("assistant-stopped")).toBeTruthy();
    // A stop is not a refusal, and not a dropped stream.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("assistant-dropped")).toBeNull();
  });

  it("shows the words that streamed before the stop, then the recorded partial reply marked Stopped", async () => {
    const held = heldTurn();
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    const on = streamed[0];
    act(() => {
      on?.onText?.("Two agents ");
      on?.onText?.("are");
    });
    expect(await screen.findByTestId("assistant-answering")).toHaveTextContent(
      "Two agents are",
    );

    await user.click(await screen.findByTestId("assistant-stop"));
    expect(postedStop().turnId).toBe(askedTurnId());
    await held.end(turn({ reply: "Two agents are", stopped: true }));

    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "Two agents are",
    );
    expect(screen.queryByTestId("assistant-answering")).toBeNull();
    expect(screen.getByTestId("assistant-stopped")).toHaveTextContent(
      "Stopped",
    );
    expect(await screen.findByTestId("assistant-send")).toBeTruthy();
  });

  // A write that parked for approval before the stop is still on the record,
  // waiting for a decision, so the stopped answer says so.
  it("stops a turn during a tool call and still shows the write it parked", async () => {
    const held = heldTurn();
    const { user } = await openFlyout();
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
    const { user } = await openFlyout();
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
    const { user } = await openFlyout();
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
  // A stop that lands before its turn registers is held, and the route
  // answers `found: false`. The stop was taken, so it is not a failure.
  it("treats a found false answer as a sent stop and marks the reply that ends stopped", async () => {
    fetchStop.mockResolvedValue(Response.json({ turnId: "t", found: false }));
    const held = heldTurn();
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    await user.click(await screen.findByTestId("assistant-stop"));
    await settleStop();

    expect(screen.queryByTestId("assistant-stop-failed")).toBeNull();
    expect(screen.getByTestId("assistant-stop")).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await held.end(turn({ reply: "", stopped: true }));
    expect(await screen.findByTestId("assistant-stopped")).toHaveTextContent(
      "Stopped",
    );
  });

  it("shows no mark when a found false stop came after the turn had finished (negative)", async () => {
    fetchStop.mockResolvedValue(Response.json({ turnId: "t", found: false }));
    const held = heldTurn();
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    await user.click(await screen.findByTestId("assistant-stop"));
    await settleStop();
    await held.end(turn());

    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "Two agents are idle.",
    );
    expect(screen.queryByTestId("assistant-stopped")).toBeNull();
    expect(screen.queryByTestId("assistant-stop-failed")).toBeNull();
    expect(await screen.findByTestId("assistant-send")).toBeTruthy();
  });

  // The route holds a stop that arrives before its turn for a minute. An id
  // reused across questions would let that stop end the next question.
  it("names each question with a fresh turn id", async () => {
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    expect(await screen.findByTestId("assistant-answer")).toBeTruthy();
    await ask(user, "and what is idle?");
    await waitFor(() => {
      expect(askAssistant).toHaveBeenCalledTimes(2);
    });

    const first = askedTurnId(0);
    const second = askedTurnId(1);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  // The workspace is renamed while its turn runs. The new slug reads the
  // same thread, so Stop still shows there. The stop names the slugs the
  // question was asked under, and the route redirects an old slug to the
  // current one (`assistant-stop.ts`).
  it("sends the stop to the workspace the question was asked in, not the page's current slugs", async () => {
    const held = heldTurn();
    const { user, renavigate } = await openFlyout();
    await ask(user, "what is live?");
    await screen.findByTestId("assistant-stop");

    act(() => {
      renavigate("/acme/platform-core");
    });
    await waitFor(() => {
      expect(loadAssistantThread).toHaveBeenCalledWith(
        "acme",
        "platform-core",
      );
    });
    await user.click(await screen.findByTestId("assistant-stop"));

    expect(postedStop()).toEqual({
      path: "/acme/core-platform/assistant/stop",
      turnId: askedTurnId(),
    });
    await held.end(turn({ reply: "", stopped: true }));
    expect(await screen.findByTestId("assistant-stopped")).toBeTruthy();
  });
});

describe("Stop under reduced motion", () => {
  beforeEach(() => {
    stubMedia(["(prefers-reduced-motion: reduce)"]);
  });
  afterEach(() => {
    stubMedia();
  });

  // The flyout once typed a finished reply out and showed Stop until the
  // typing ended. Reduced motion skipped the typing, so it had to report
  // itself done at once, or Stop stayed after every answer (#4164). #4204
  // replaced the typing with the live stream. This case fails if a reveal
  // comes back and holds Stop for a person who asked for less motion.
  it("paints the answer whole and gives Send back when the turn ends", async () => {
    const held = heldTurn();
    const { user } = await openFlyout();
    await ask(user, "what is live?");
    expect(await screen.findByTestId("assistant-stop")).toBeTruthy();
    await held.end(turn());

    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "Two agents are idle.",
    );
    expect(await screen.findByTestId("assistant-send")).toBeTruthy();
    expect(screen.queryByTestId("assistant-stop")).toBeNull();
    expect(screen.queryByTestId("assistant-stopped")).toBeNull();
    expect(fetchStop).not.toHaveBeenCalled();
  });
});

describe("A stopped reply after a reload", () => {
  // The thread as get_conversation reads it back: the partial reply was
  // saved with its stop, and the read says so (#4164).
  const STOPPED_THREAD: AssistantThread = {
    id: "cnv_01k9x2",
    messages: [
      {
        id: "msg_a1",
        role: "user",
        text: "what is live?",
        runId: null,
        parked: [],
        toolCalls: [],
        stopped: false,
      },
      {
        id: "msg_a2",
        role: "assistant",
        text: "Two agents are",
        runId: "arun_01k9",
        parked: [],
        toolCalls: [],
        stopped: true,
      },
    ],
    truncated: false,
  };

  it("shows the words the turn reached, whole and marked Stopped, with Send ready", async () => {
    loadAssistantThread.mockResolvedValue({
      ok: true,
      value: {
        workspaceKey: "7b000000-0000-4000-8000-000000000001",
        thread: STOPPED_THREAD,
      },
    });
    await openFlyout();

    const answer = await screen.findByTestId("assistant-answer");
    expect(answer).toHaveTextContent("Two agents are");
    expect(screen.getByTestId("assistant-stopped")).toHaveTextContent(
      "Stopped",
    );
    expect(screen.getByTestId("assistant-recorded-as")).toHaveTextContent(
      "recorded as arun_01k9",
    );
    // The turn ended before the reload, so there is nothing to stop.
    expect(screen.getByTestId("assistant-send")).toBeTruthy();
    expect(screen.queryByTestId("assistant-stop")).toBeNull();
    expect(fetchStop).not.toHaveBeenCalled();
  });
});
