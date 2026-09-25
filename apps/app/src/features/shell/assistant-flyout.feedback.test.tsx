// @vitest-environment jsdom
// Reply feedback in the assistant flyout (#4169) over a fake turn stream and
// fake feedback action: that every answered reply carries Useful and Wrong,
// that Useful records at once, that Wrong takes an optional short note first,
// that the person is told the vote was recorded, that a vote that failed says
// so and keeps the note, that a stopped reply and a reply loaded after its
// stream dropped can be rated like any other, and that no vote is offered
// outside a workspace.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { ShellStateProvider, useShellState } from "./shell-state";

const mocks = vi.hoisted(() => ({
  askAssistantStream: vi.fn(),
  readAssistantReply: vi.fn(),
  recordReplyFeedback: vi.fn(),
  pathname: vi.fn(() => "/acme/core-platform"),
}));
// The turn streams over the API's chat stream (assistant-stream-client.ts).
// What arrives while it streams is assistant-flyout.streaming.test.tsx; here
// the fake answers with the finished turn at once.
vi.mock("./assistant-stream-client", () => ({
  askAssistantStream: mocks.askAssistantStream,
}));
// The cost line under each reply has its own file
// (assistant-flyout.reply-cost.test.tsx). Here its read never answers, so the
// line holds "pending" and the votes are the only thing under test.
vi.mock("./assistant-actions", () => ({
  readAssistantReply: mocks.readAssistantReply,
  readReplyCost: () => new Promise(() => undefined),
}));
// The engine read has its own file (assistant-flyout.engine-health.test.tsx).
// Here it never answers, so its notice draws nothing and holds nothing.
vi.mock("./engine-actions", () => ({
  readAssistantEngine: () => new Promise(() => undefined),
}));
vi.mock("./assistant-feedback-actions", () => ({
  recordReplyFeedback: mocks.recordReplyFeedback,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname().split("?")[0],
  useSearchParams: () =>
    new URLSearchParams(mocks.pathname().split("?")[1] ?? ""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");
const { AssistantReplyFeedback } = await import("./assistant-reply-feedback");

const CONVERSATION = "6f1f5a8e-0000-4000-8000-00000000c0de";
const RUN = "arun_01k9";

const turn = {
  ok: true,
  value: {
    conversationId: CONVERSATION,
    runId: RUN,
    reply: "Three runs are live.",
    parkedCards: [],
    // #4256 made a turn carry the tool calls its run made; the stream client
    // defaults the list to [], so a live answer always has one.
    toolCalls: [],
    stopped: false,
  },
};

const recorded = (verdict: "useful" | "wrong") => ({
  ok: true,
  value: { runId: RUN, verdict, recordedAt: "2026-09-25T10:00:00.000Z" },
});

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

const tree = () => (
  <IntlProvider>
    <ShellStateProvider>
      <OpenIt />
      <AssistantFlyout />
    </ShellStateProvider>
  </IntlProvider>
);

/** Open the flyout, ask one question, and wait for its answer. */
async function answered() {
  const user = userEvent.setup();
  const { rerender } = render(tree());
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  await user.type(screen.getByTestId("assistant-composer"), "what is live?");
  await user.click(screen.getByTestId("assistant-send"));
  const answer = await screen.findByTestId("assistant-answer");
  return {
    user,
    answer,
    flyout: screen.getByTestId("assistant-flyout"),
    renavigate: (to: string) => {
      mocks.pathname.mockReturnValue(to);
      rerender(tree());
    },
  };
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
  mocks.askAssistantStream.mockReset();
  mocks.readAssistantReply.mockReset();
  mocks.recordReplyFeedback.mockReset();
  mocks.askAssistantStream.mockResolvedValue(turn);
  mocks.pathname.mockReturnValue("/acme/core-platform");
});
afterEach(cleanup);

describe("reply feedback in the flyout", () => {
  it("puts Useful and Wrong under an answered reply, in a group named for the reply", async () => {
    const { answer, flyout } = await answered();

    const group = within(answer).getByRole("group", {
      name: "Rate this reply",
    });
    expect(
      within(group).getByRole("button", { name: "Useful" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(group).getByRole("button", { name: "Wrong" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
    await expectNoAxe(flyout);
  });

  it("records Useful at once against the reply's run, and says it was recorded", async () => {
    mocks.recordReplyFeedback.mockResolvedValue(recorded("useful"));
    const { user } = await answered();

    await user.click(screen.getByTestId("assistant-feedback-useful"));

    expect(mocks.recordReplyFeedback).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "useful",
        note: null,
      },
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("assistant-feedback-recorded"),
      ).toHaveTextContent("Recorded as useful against this run.");
    });
    expect(screen.getByTestId("assistant-feedback-useful")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // A second press of the vote already recorded writes nothing more.
    await user.click(screen.getByTestId("assistant-feedback-useful"));
    expect(mocks.recordReplyFeedback).toHaveBeenCalledTimes(1);
  });

  it("opens a short note on Wrong, sends it trimmed, and gives focus back to Wrong", async () => {
    mocks.recordReplyFeedback.mockResolvedValue(recorded("wrong"));
    const { user, flyout } = await answered();

    await user.click(screen.getByTestId("assistant-feedback-wrong"));
    const note = screen.getByRole("textbox", {
      name: "What was wrong? Optional.",
    });
    expect(note).toHaveFocus();
    expect(note).toHaveAttribute("maxlength", "500");
    expect(note).toHaveAccessibleDescription("Up to 500 characters.");
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
    await expectNoAxe(flyout);

    await user.type(note, "  It named the wrong agent.  ");
    await user.click(screen.getByRole("button", { name: "Record as wrong" }));

    expect(mocks.recordReplyFeedback).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "wrong",
        note: "It named the wrong agent.",
      },
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("assistant-feedback-recorded"),
      ).toHaveTextContent("Recorded as wrong against this run.");
    });
    expect(screen.queryByTestId("assistant-feedback-note-form")).toBeNull();
    expect(screen.getByTestId("assistant-feedback-wrong")).toHaveFocus();
    expect(screen.getByTestId("assistant-feedback-wrong")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("sends Wrong with no note as null", async () => {
    mocks.recordReplyFeedback.mockResolvedValue(recorded("wrong"));
    const { user } = await answered();

    await user.click(screen.getByTestId("assistant-feedback-wrong"));
    await user.type(screen.getByTestId("assistant-feedback-note"), "   ");
    await user.click(screen.getByTestId("assistant-feedback-send"));

    expect(mocks.recordReplyFeedback).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({ verdict: "wrong", note: null }),
    );
  });

  it("records a change of mind as a second vote, and presses only the newest", async () => {
    mocks.recordReplyFeedback
      .mockResolvedValueOnce(recorded("useful"))
      .mockResolvedValueOnce(recorded("wrong"));
    const { user } = await answered();

    await user.click(screen.getByTestId("assistant-feedback-useful"));
    await waitFor(() => {
      expect(screen.getByTestId("assistant-feedback-useful")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    await user.click(screen.getByTestId("assistant-feedback-wrong"));
    await user.click(screen.getByTestId("assistant-feedback-send"));

    await waitFor(() => {
      expect(screen.getByTestId("assistant-feedback-wrong")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(screen.getByTestId("assistant-feedback-useful")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(mocks.recordReplyFeedback).toHaveBeenNthCalledWith(
      1,
      "acme",
      "core-platform",
      expect.objectContaining({ verdict: "useful" }),
    );
    expect(mocks.recordReplyFeedback).toHaveBeenNthCalledWith(
      2,
      "acme",
      "core-platform",
      expect.objectContaining({ verdict: "wrong" }),
    );
  });

  it("says a refused vote was not recorded and keeps the note to send again (negative)", async () => {
    mocks.recordReplyFeedback
      .mockResolvedValueOnce({
        ok: false,
        reason: "unavailable",
        code: "clickhouse_unavailable",
      })
      .mockResolvedValueOnce(recorded("wrong"));
    const { user } = await answered();

    await user.click(screen.getByTestId("assistant-feedback-wrong"));
    await user.type(screen.getByTestId("assistant-feedback-note"), "Off by 2");
    await user.click(screen.getByTestId("assistant-feedback-send"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your rating was not recorded. Try again.",
    );
    expect(screen.getByTestId("assistant-feedback-recorded")).toHaveTextContent(
      "",
    );
    expect(screen.getByTestId("assistant-feedback-note")).toHaveValue(
      "Off by 2",
    );

    await user.click(screen.getByTestId("assistant-feedback-send"));
    await waitFor(() => {
      expect(
        screen.getByTestId("assistant-feedback-recorded"),
      ).toHaveTextContent("Recorded as wrong against this run.");
    });
    expect(screen.queryByTestId("assistant-feedback-failed")).toBeNull();
  });

  it("says a vote that threw was not recorded (negative)", async () => {
    mocks.recordReplyFeedback.mockRejectedValue(new Error("network"));
    const { user } = await answered();

    await user.click(screen.getByTestId("assistant-feedback-useful"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your rating was not recorded. Try again.",
    );
    expect(screen.getByTestId("assistant-feedback-useful")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("closes the note on Escape and leaves the flyout open", async () => {
    const { user, flyout } = await answered();

    await user.click(screen.getByTestId("assistant-feedback-wrong"));
    fireEvent.keyDown(screen.getByTestId("assistant-feedback-note"), {
      key: "Escape",
    });

    expect(screen.queryByTestId("assistant-feedback-note-form")).toBeNull();
    expect(flyout).toHaveAttribute("data-state", "open");
    expect(screen.getByTestId("assistant-feedback-wrong")).toHaveFocus();
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
  });

  it("offers no vote on an organization page, where there is no workspace to record it in (negative)", async () => {
    const { renavigate } = await answered();
    expect(screen.getByTestId("assistant-feedback")).toBeTruthy();

    renavigate("/acme");

    expect(screen.getByTestId("assistant-answer")).toBeTruthy();
    expect(screen.queryByTestId("assistant-feedback")).toBeNull();
  });

  it("offers the vote on a reply the person stopped, which is still recorded under its run", async () => {
    // A stopped turn saves the words it reached as the run's assistant
    // message (#4164), so record_reply_feedback resolves a vote on it.
    mocks.askAssistantStream.mockResolvedValue({
      ...turn,
      value: { ...turn.value, reply: "Two agents are", stopped: true },
    });
    mocks.recordReplyFeedback.mockResolvedValue(recorded("wrong"));
    const { user, answer } = await answered();

    expect(within(answer).getByTestId("assistant-stopped")).toBeTruthy();
    // The stopped reply keeps its cost line (#4167) too, and the line sits
    // with the run it reads, above the votes.
    const cost = within(answer).getByTestId("assistant-reply-cost");
    const votes = within(answer).getByTestId("assistant-feedback");
    expect(
      cost.compareDocumentPosition(votes) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(within(answer).getByTestId("assistant-feedback-wrong"));
    await user.click(screen.getByTestId("assistant-feedback-send"));

    expect(mocks.recordReplyFeedback).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "wrong",
        note: null,
      },
    );
  });

  it("offers the vote on a reply loaded after its stream dropped, under the run the stream named", async () => {
    mocks.askAssistantStream.mockResolvedValue({
      ok: false,
      reason: "dropped",
      runId: RUN,
    });
    mocks.readAssistantReply.mockResolvedValue({
      ok: true,
      value: {
        state: "answered",
        conversationId: CONVERSATION,
        reply: "Three runs are live.",
        stopped: false,
      },
    });
    mocks.recordReplyFeedback.mockResolvedValue(recorded("useful"));
    const user = userEvent.setup();
    render(tree());
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    await user.type(screen.getByTestId("assistant-composer"), "what is live?");
    await user.click(screen.getByTestId("assistant-send"));

    // A dropped stream is not a reply yet: nothing to rate until it loads.
    await screen.findByTestId("assistant-dropped");
    expect(screen.queryByTestId("assistant-feedback")).toBeNull();

    await user.click(screen.getByTestId("assistant-load-reply"));
    const answer = await screen.findByTestId("assistant-answer");
    await user.click(within(answer).getByTestId("assistant-feedback-useful"));

    expect(mocks.recordReplyFeedback).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "useful",
        note: null,
      },
    );
  });

  it("rates a loaded reply in the conversation it was saved in, not the one asked since", async () => {
    // The first turn's stream drops before it names a conversation, and the
    // person asks something else, which starts a second one. The first reply, loaded
    // afterwards, still sits in its own conversation, and a vote on it that
    // named the thread's current one would be refused.
    const EARLIER = "6f1f5a8e-0000-4000-8000-00000000c0d1";
    const EARLIER_RUN = "arun_01k8";
    mocks.askAssistantStream
      .mockResolvedValueOnce({
        ok: false,
        reason: "dropped",
        runId: EARLIER_RUN,
      })
      .mockResolvedValueOnce(turn);
    mocks.readAssistantReply.mockResolvedValue({
      ok: true,
      value: {
        state: "answered",
        conversationId: EARLIER,
        reply: "Two runs are live.",
        stopped: false,
      },
    });
    mocks.recordReplyFeedback.mockResolvedValue(recorded("wrong"));
    const user = userEvent.setup();
    render(tree());
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    await user.type(screen.getByTestId("assistant-composer"), "what is live?");
    await user.click(screen.getByTestId("assistant-send"));
    await screen.findByTestId("assistant-dropped");
    await user.type(screen.getByTestId("assistant-composer"), "and now?");
    await user.click(screen.getByTestId("assistant-send"));
    await screen.findByTestId("assistant-answer");
    // Asked with no conversation yet, so the second turn started its own.
    expect(mocks.askAssistantStream.mock.calls[1]?.[2]).toMatchObject({
      conversationId: null,
    });

    await user.click(screen.getByTestId("assistant-load-reply"));
    await waitFor(() => {
      expect(screen.getAllByTestId("assistant-answer")).toHaveLength(2);
    });
    const [loaded, retried] = screen.getAllByTestId("assistant-answer");
    if (loaded === undefined || retried === undefined)
      throw new Error("expected two answers");
    expect(loaded).toHaveTextContent("Two runs are live.");

    await user.click(within(loaded).getByTestId("assistant-feedback-wrong"));
    await user.click(within(loaded).getByTestId("assistant-feedback-send"));
    await user.click(within(retried).getByTestId("assistant-feedback-wrong"));
    await user.click(within(retried).getByTestId("assistant-feedback-send"));

    expect(mocks.recordReplyFeedback).toHaveBeenNthCalledWith(
      1,
      "acme",
      "core-platform",
      {
        conversationId: EARLIER,
        runId: EARLIER_RUN,
        verdict: "wrong",
        note: null,
      },
    );
    expect(mocks.recordReplyFeedback).toHaveBeenNthCalledWith(
      2,
      "acme",
      "core-platform",
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "wrong",
        note: null,
      },
    );
  });

  it("offers no vote on a refused turn (negative)", async () => {
    mocks.askAssistantStream.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "engine_unavailable",
    });
    const user = userEvent.setup();
    render(tree());
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    await user.type(screen.getByTestId("assistant-composer"), "hi");
    await user.click(screen.getByTestId("assistant-send"));

    await screen.findByTestId("assistant-engine");
    expect(screen.queryByTestId("assistant-feedback")).toBeNull();
  });
});

describe("AssistantReplyFeedback on its own", () => {
  it("disables both votes while one is being recorded", async () => {
    let settle: (value: unknown) => void = () => undefined;
    mocks.recordReplyFeedback.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    const { container } = render(
      <IntlProvider>
        <AssistantReplyFeedback
          org="acme"
          ws="core-platform"
          conversationId={CONVERSATION}
          runId={RUN}
        />
      </IntlProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Useful" }));
    expect(screen.getByRole("button", { name: "Useful" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wrong" })).toBeDisabled();

    settle(recorded("useful"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Wrong" })).toBeEnabled();
    });
    await expectNoAxe(container);
  });
});
