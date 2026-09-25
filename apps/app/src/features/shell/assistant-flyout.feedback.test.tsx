// @vitest-environment jsdom
// Reply feedback in the assistant flyout (#4169) over fake turn and feedback
// actions: that every answered reply carries Useful and Wrong, that Useful
// records at once, that Wrong takes an optional short note first, that the
// person is told the vote was recorded, that a vote that failed says so and
// keeps the note, and that no vote is offered outside a workspace.
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
  askAssistant: vi.fn(),
  recordReplyFeedback: vi.fn(),
  pathname: vi.fn(() => "/acme/core-platform"),
}));
vi.mock("./assistant-actions", () => ({ askAssistant: mocks.askAssistant }));
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
    userMessageId: "6f1f5a8e-0000-4000-8000-00000000a001",
    assistantMessageId: "6f1f5a8e-0000-4000-8000-00000000a002",
    runId: RUN,
    reply: "Three runs are live.",
    parkedCards: [],
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
  mocks.askAssistant.mockReset();
  mocks.recordReplyFeedback.mockReset();
  mocks.askAssistant.mockResolvedValue(turn);
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
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recorded as useful against this run.",
      );
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
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recorded as wrong against this run.",
      );
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
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByTestId("assistant-feedback-note")).toHaveValue(
      "Off by 2",
    );

    await user.click(screen.getByTestId("assistant-feedback-send"));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recorded as wrong against this run.",
      );
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

  it("offers no vote on a refused turn (negative)", async () => {
    mocks.askAssistant.mockResolvedValue({
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
