// @vitest-environment jsdom
// A reply streamed into the assistant flyout (ADR-176), over a fake stream
// client the test drives fragment by fragment: the text appears as the engine
// writes it, the tool it is calling is named while it runs, a refusal
// mid-stream replaces what arrived, and a dropped stream keeps what arrived
// and loads the finished reply from the run.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import type {
  AssistantQuestion,
  AssistantStreamHandlers,
  AssistantStreamResult,
} from "./assistant-stream-client";
import { ShellStateProvider, useShellState } from "./shell-state";

/** One turn the test is driving: the handlers the flyout passed, and its end. */
type Turn = {
  question: AssistantQuestion;
  on: AssistantStreamHandlers;
  end: (result: AssistantStreamResult) => void;
};

const turns: Turn[] = [];
const askAssistantStream = vi.fn(
  (
    _org: string,
    _ws: string,
    question: AssistantQuestion,
    on: AssistantStreamHandlers = {},
  ) =>
    new Promise<AssistantStreamResult>((resolve) => {
      turns.push({ question, on, end: resolve });
    }),
);
const readAssistantReply = vi.fn();
vi.mock("./assistant-stream-client", () => ({ askAssistantStream }));
vi.mock("./assistant-actions", () => ({ readAssistantReply }));
// The engine read has its own file (assistant-flyout.engine-health.test.tsx).
// Here it never answers, so nothing but a turn in flight holds Send.
vi.mock("./engine-actions", () => ({
  readAssistantEngine: () => new Promise(() => undefined),
}));
// The workspace reads back as having no thread yet, filed under its own id.
// assistant-flyout.threads.test.tsx covers the read itself (#4163).
vi.mock("./assistant-thread-actions", () => ({
  loadAssistantThread: (_org: string, ws: string) =>
    Promise.resolve({
      ok: true,
      value: { workspaceKey: `id-${ws}`, thread: null },
    }),
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");

const RUN = "arun_01k9";
const CONVERSATION = "6f1f5a8e-0000-4000-8000-00000000c0de";

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

async function askInOpenFlyout(text: string) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AssistantFlyout />
      </ShellStateProvider>
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  await user.type(screen.getByTestId("assistant-composer"), text);
  await user.click(screen.getByTestId("assistant-send"));
  await waitFor(() => {
    expect(turns).toHaveLength(1);
  });
  return {
    user,
    turn: current(),
    flyout: screen.getByTestId("assistant-flyout"),
  };
}

/** The turn in flight: the last one the flyout asked. */
function current(): Turn {
  const turn = turns.at(-1);
  if (turn === undefined) throw new Error("no turn was asked");
  return turn;
}

/** Deliver stream events the way a network chunk does: in one task. */
function stream(deliver: () => void) {
  act(deliver);
}

async function end(turn: Turn, result: AssistantStreamResult) {
  await act(async () => {
    turn.end(result);
    await Promise.resolve();
  });
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  turns.length = 0;
  askAssistantStream.mockClear();
  readAssistantReply.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

describe("a streamed reply", () => {
  it("paints the reply as the engine writes it, then shows the finished reply with its run", async () => {
    const { turn } = await askInOpenFlyout("what is live?");

    stream(() => {
      turn.on.onRun?.(RUN);
      turn.on.onText?.("Three runs ");
    });
    expect(screen.getByTestId("assistant-answering")).toHaveTextContent(
      "Three runs",
    );
    stream(() => {
      turn.on.onText?.("are live.");
    });
    expect(screen.getByTestId("assistant-answering")).toHaveTextContent(
      "Three runs are live.",
    );
    // Still in flight: the spinner is up and no reply is claimed yet.
    expect(screen.getByTestId("assistant-thinking")).toBeTruthy();
    expect(screen.queryByTestId("assistant-answer")).toBeNull();

    await end(turn, {
      ok: true,
      value: {
        conversationId: CONVERSATION,
        runId: RUN,
        reply: "Three runs are live.",
        parkedCards: [],
        toolCalls: [],
        stopped: false,
      },
    });

    expect(screen.queryByTestId("assistant-answering")).toBeNull();
    expect(screen.queryByTestId("assistant-thinking")).toBeNull();
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
    expect(screen.getByRole("link", { name: RUN }).getAttribute("href")).toBe(
      `/acme/core-platform/runs/${RUN}`,
    );
  });

  it("names the tool the turn is calling while it runs, and drops the line when it ends", async () => {
    const { turn } = await askInOpenFlyout("what is live?");

    stream(() => {
      turn.on.onToolStart?.({ id: "c1", capability: "list_runs" });
    });
    expect(screen.getByTestId("assistant-tool-running")).toHaveTextContent(
      "Calling list_runs…",
    );
    stream(() => {
      turn.on.onToolEnd?.({ id: "c1", status: "completed" });
    });
    expect(screen.queryByTestId("assistant-tool-running")).toBeNull();
  });

  // The transcript is a live region, and a reply that grows on every fragment
  // would be read out as fragments. The growing copy is kept out of the
  // accessibility tree, and the finished reply arrives as a new entry the
  // region reads once.
  it("keeps the growing reply out of the accessibility tree, and announces the finished reply as a new entry", async () => {
    const { turn } = await askInOpenFlyout("what is live?");
    const log = screen.getByRole("log");

    stream(() => {
      turn.on.onText?.("Read [the runbook](https://oxagen.sh/docs)");
    });
    const growing = screen.getByTestId("assistant-answering");
    expect(growing).toHaveAttribute("aria-hidden", "true");
    expect(growing).toHaveAttribute("inert");

    await end(turn, {
      ok: true,
      value: {
        conversationId: CONVERSATION,
        runId: RUN,
        reply: "Read [the runbook](https://oxagen.sh/docs) first.",
        parkedCards: [],
        toolCalls: [],
        stopped: false,
      },
    });
    const answer = screen.getByTestId("assistant-answer");
    expect(growing.isConnected).toBe(false);
    expect(log).toContainElement(answer);
    expect(answer).toHaveTextContent("Read the runbook first.");
  });

  it("continues the conversation the streamed turn opened", async () => {
    const { user, turn } = await askInOpenFlyout("what is live?");
    await end(turn, {
      ok: true,
      value: {
        conversationId: CONVERSATION,
        runId: RUN,
        reply: "Three runs are live.",
        parkedCards: [],
        toolCalls: [],
        stopped: false,
      },
    });
    await user.type(screen.getByTestId("assistant-composer"), "and failed?");
    await user.click(screen.getByTestId("assistant-send"));
    await waitFor(() => {
      expect(turns).toHaveLength(2);
    });
    expect(current().question).toMatchObject({
      conversationId: CONVERSATION,
      content: "and failed?",
    });
  });
});

describe("a refusal mid-stream", () => {
  it("replaces what arrived with the refusal, since nothing of it is saved as a reply (negative)", async () => {
    const { turn } = await askInOpenFlyout("what is live?");
    stream(() => {
      turn.on.onRun?.(RUN);
      turn.on.onText?.("Three runs");
    });
    expect(screen.getByTestId("assistant-answering")).toHaveTextContent(
      "Three runs",
    );

    await end(turn, {
      ok: false,
      reason: "unavailable",
      code: "engine_unavailable",
    });

    expect(screen.queryByTestId("assistant-answering")).toBeNull();
    expect(screen.queryByText("Three runs")).toBeNull();
    expect(screen.getByTestId("assistant-engine")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.getByTestId("assistant-refusal-code")).toHaveTextContent(
      "engine_unavailable",
    );
    expect(screen.getByTestId("assistant-retry")).toBeTruthy();
  });

  it("reads a budget stop mid-reply as the turn stopped before it answered (negative)", async () => {
    const { turn } = await askInOpenFlyout("summarize spend");
    stream(() => {
      turn.on.onText?.("Spend this month");
    });
    await end(turn, { ok: false, reason: "conflict", code: "engine_aborted" });
    expect(screen.getByTestId("assistant-aborted")).toBeTruthy();
    expect(screen.queryByTestId("assistant-answer")).toBeNull();
  });
});

describe("a dropped stream", () => {
  async function dropMidReply() {
    const asked = await askInOpenFlyout("what is live?");
    stream(() => {
      asked.turn.on.onRun?.(RUN);
      asked.turn.on.onText?.("Three runs");
    });
    await end(asked.turn, { ok: false, reason: "dropped", runId: RUN });
    return asked;
  }

  it("keeps what arrived, names the run, and offers to load the finished reply", async () => {
    await dropMidReply();

    const dropped = screen.getByTestId("assistant-dropped");
    expect(dropped).toHaveTextContent("Three runs");
    expect(screen.getByTestId("assistant-dropped-note")).toHaveTextContent(
      "The connection dropped before the reply finished.",
    );
    expect(
      screen.getByTestId("assistant-dropped-run").getAttribute("href"),
    ).toBe(`/acme/core-platform/runs/${RUN}`);
    expect(screen.getByTestId("assistant-load-reply")).toHaveTextContent(
      "Load the finished reply",
    );
    // The stream is over; the composer is the person's again.
    expect(screen.queryByTestId("assistant-thinking")).toBeNull();
    expect(screen.getByTestId("assistant-composer")).not.toBeDisabled();
  });

  it("loads the finished reply from the run, and continues its conversation", async () => {
    const { user } = await dropMidReply();
    readAssistantReply.mockResolvedValue({
      ok: true,
      value: {
        state: "answered",
        conversationId: CONVERSATION,
        reply: "Three runs are live.",
        stopped: false,
      },
    });

    await user.click(screen.getByTestId("assistant-load-reply"));

    expect(readAssistantReply).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      RUN,
    );
    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
    expect(screen.queryByTestId("assistant-dropped")).toBeNull();

    await user.type(screen.getByTestId("assistant-composer"), "and failed?");
    await user.click(screen.getByTestId("assistant-send"));
    await waitFor(() => {
      expect(turns).toHaveLength(2);
    });
    expect(current().question).toMatchObject({ conversationId: CONVERSATION });
    expect(screen.queryByTestId("assistant-stopped")).toBeNull();
  });

  // The person stopped the turn and the stream dropped before its terminal:
  // the reply the stop kept loads marked Stopped (#4164).
  it("loads a stopped turn's reply marked Stopped", async () => {
    const { user } = await dropMidReply();
    readAssistantReply.mockResolvedValue({
      ok: true,
      value: {
        state: "answered",
        conversationId: CONVERSATION,
        reply: "Three runs",
        stopped: true,
      },
    });

    await user.click(screen.getByTestId("assistant-load-reply"));

    expect(await screen.findByTestId("assistant-answer")).toHaveTextContent(
      "Three runs",
    );
    expect(screen.getByTestId("assistant-stopped")).toHaveTextContent(
      "Stopped",
    );
  });

  it("says when the reply is not saved yet, keeps the offer, and says when the turn ended without one (negative)", async () => {
    const { user } = await dropMidReply();
    readAssistantReply.mockResolvedValueOnce({
      ok: true,
      value: { state: "running" },
    });
    await user.click(screen.getByTestId("assistant-load-reply"));
    expect(
      await screen.findByTestId("assistant-dropped-running"),
    ).toHaveTextContent("stella has not saved the reply yet.");
    expect(screen.getByTestId("assistant-dropped")).toHaveTextContent(
      "Three runs",
    );

    readAssistantReply.mockResolvedValueOnce({
      ok: true,
      value: { state: "ended" },
    });
    await user.click(screen.getByTestId("assistant-load-reply"));
    expect(
      await screen.findByTestId("assistant-dropped-ended"),
    ).toHaveTextContent("This turn ended without a reply.");
    expect(screen.queryByTestId("assistant-load-reply")).toBeNull();
  });

  it("says the reply could not be loaded when the read is refused (negative)", async () => {
    const { user } = await dropMidReply();
    readAssistantReply.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "control_plane_down",
    });
    await user.click(screen.getByTestId("assistant-load-reply"));
    expect(
      await screen.findByTestId("assistant-dropped-unread"),
    ).toHaveTextContent("The reply could not be loaded.");
    expect(screen.getByTestId("assistant-load-reply")).toBeTruthy();
  });

  it("offers to ask again when the stream dropped before it named a run (negative)", async () => {
    const { user, turn } = await askInOpenFlyout("what is live?");
    await end(turn, { ok: false, reason: "dropped", runId: null });

    expect(screen.getByTestId("assistant-dropped-note")).toHaveTextContent(
      "The connection dropped before stella named the run",
    );
    expect(screen.queryByTestId("assistant-load-reply")).toBeNull();

    await user.click(screen.getByTestId("assistant-retry"));
    await waitFor(() => {
      expect(turns).toHaveLength(2);
    });
    expect(current().question).toMatchObject({ content: "what is live?" });
  });

  it("keeps the writes the turn parked before the drop, and refreshes the waiting count", async () => {
    const { turn } = await askInOpenFlyout("rotate the key");
    stream(() => {
      turn.on.onRun?.(RUN);
      turn.on.onParked?.({
        approvalId: "apr_01",
        capability: "rotate_api_key",
        expiresAt: "2026-09-25T10:05:00.000Z",
      });
    });
    await end(turn, { ok: false, reason: "dropped", runId: RUN });

    expect(screen.getByTestId("assistant-dropped")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations while a reply streams and after its stream drops", async () => {
    const { turn, flyout } = await askInOpenFlyout("what is live?");
    stream(() => {
      turn.on.onRun?.(RUN);
      turn.on.onText?.("Three runs");
      turn.on.onToolStart?.({ id: "c1", capability: "list_runs" });
    });
    await expectNoAxe(flyout);
    await end(turn, { ok: false, reason: "dropped", runId: RUN });
    await expectNoAxe(flyout);
  });
});
