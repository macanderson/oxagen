// @vitest-environment jsdom
// The assistant's thread across a reload, a workspace rename, "New thread"
// and the session list (#4163, #3313, #4435), with the files sent in it
// (#4690). The turn's stream and the reads are fakes: the thread read answers
// the thread the record holds and the workspace id the flyout files it under,
// and the list answers the sessions, so each case shows what the person sees.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { nth } from "@/test/nth";
import { ShellStateProvider, useShellState } from "./shell-state";

// The turn streams from the API (assistant-stream-client.ts, ADR-176) and
// answers in the shape the Server Action it replaced did, so one fake that
// takes the same three arguments drives it.
const askAssistant =
  vi.fn<(org: string, ws: string, question: unknown) => Promise<unknown>>();
vi.mock("./assistant-stream-client", () => ({
  askAssistantStream: (org: string, ws: string, question: unknown) =>
    askAssistant(org, ws, question),
}));
vi.mock("./assistant-actions", () => ({ readAssistantReply: vi.fn() }));
const loadAssistantThread = vi.fn();
const listAssistantSessions = vi.fn();
const openAssistantSession = vi.fn();
vi.mock("./assistant-thread-actions", () => ({
  loadAssistantThread,
  listAssistantSessions,
  openAssistantSession,
}));
// The parked cards have their own tests (assistant-parked-approvals.test.tsx).
// This stand-in records the workspace and run the flyout hands them.
const parkedApprovals =
  vi.fn<(props: { org: string; ws: string; runId: string }) => void>();
vi.mock("./assistant-parked-approvals", () => ({
  AssistantParkedApprovals: (props: {
    org: string;
    ws: string;
    runId: string;
  }) => {
    parkedApprovals(props);
    return <div data-testid="parked-cards" />;
  },
}));

const pathname = vi.fn(() => "/acme/core-platform");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");

/** Any turn id: the flyout mints a new one for each question (#4164). */
const A_TURN_ID: unknown = expect.any(String);

/** The workspace's id: what a rename leaves alone. */
const WORKSPACE = "7b000000-0000-4000-8000-000000000001";

const RECORDED: AssistantThread = {
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
      attachments: [],
    },
    {
      id: "msg_a2",
      role: "assistant",
      text: "Three runs are live.",
      runId: "arun_01k9",
      parked: [
        {
          approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
          capability: "set_budget",
          expiresAt: "2026-09-25T10:05:00.000Z",
        },
      ],
      // The calls get_conversation read from the reply's run (#4161).
      toolCalls: [
        {
          toolCallRef: "tc-1",
          toolName: "list_runs",
          outcome: "completed",
          durationMs: 41,
          approvalId: null,
        },
        {
          toolCallRef: "tc-2",
          toolName: "set_budget",
          outcome: "parked",
          durationMs: 88,
          approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
        },
      ],
      stopped: false,
      attachments: [],
    },
  ],
  truncated: false,
};

// Two files sent with a question, as get_conversation reads them back
// (#4690).
const CHART = {
  publicId: "gen_01k9chart",
  name: "chart.png",
  mediaType: "image/png",
  sizeBytes: 2048,
};
const BUDGET = {
  publicId: "gen_01k9budget",
  name: "budget.pdf",
  mediaType: "application/pdf",
  sizeBytes: 512,
};

/** `thread` with `files` on each of its questions. */
const withFiles = (
  thread: AssistantThread,
  files: AssistantThread["messages"][number]["attachments"],
): AssistantThread => ({
  ...thread,
  messages: thread.messages.map((message) =>
    message.role === "user" ? { ...message, attachments: files } : message,
  ),
});

const loaded = (thread: AssistantThread | null, key = WORKSPACE) => ({
  ok: true,
  value: { workspaceKey: key, thread },
});

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
  const { rerender, unmount } = render(tree());
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  const renavigate = (to: string) => {
    pathname.mockReturnValue(to);
    rerender(tree());
  };
  return { user, renavigate, unmount };
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByTestId("assistant-composer"), text);
  await user.click(screen.getByTestId("assistant-send"));
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
  askAssistant.mockReset();
  loadAssistantThread.mockReset();
  listAssistantSessions.mockReset();
  openAssistantSession.mockReset();
  parkedApprovals.mockReset();
  askAssistant.mockResolvedValue(turn());
  loadAssistantThread.mockResolvedValue(loaded(RECORDED));
  pathname.mockReturnValue("/acme/core-platform");
});
afterEach(cleanup);

describe("the assistant's thread across a reload", () => {
  it("shows the thread the record holds when the flyout opens, whole and linked to its run", async () => {
    await openFlyout();

    expect(loadAssistantThread).toHaveBeenCalledWith("acme", "core-platform");
    expect(await screen.findByText("what is live?")).toBeTruthy();
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
    expect(screen.getByTestId("assistant-recorded-as")).toHaveTextContent(
      "recorded as arun_01k9",
    );
    expect(screen.getByTestId("assistant-parked")).toBeTruthy();
    // A reply that ran to the end carries no Stopped mark (#4164).
    expect(screen.queryByTestId("assistant-stopped")).toBeNull();
    expect(screen.queryByTestId("assistant-intro")).toBeNull();
  });

  // #4161: a restored reply lists the calls its run made, as it did when new.
  it("lists the tool calls behind a restored reply under it", async () => {
    await openFlyout();
    const calls = await screen.findByTestId("assistant-tool-calls");
    expect(screen.getByTestId("assistant-answer")).toContainElement(calls);
    expect(calls).toHaveTextContent("2 tool calls");
    expect(
      screen
        .getAllByTestId("assistant-tool-call")
        .map((row) => row.dataset.outcome),
    ).toEqual(["completed", "parked"]);
    // The parked call names the approval its card decides.
    expect(
      screen.getByTestId("assistant-tool-call-approval"),
    ).toHaveTextContent("apr_01k5rt9xq7v3m8n2p4s6t8w0");
    await expectNoAxe(calls);
  });

  it("draws no tool-call list for a restored reply whose run made no calls (negative)", async () => {
    loadAssistantThread.mockResolvedValue(
      loaded({
        ...RECORDED,
        messages: RECORDED.messages.map((m) => ({ ...m, toolCalls: [] })),
      }),
    );
    await openFlyout();
    await screen.findByTestId("assistant-recorded-as");
    expect(screen.queryByTestId("assistant-tool-calls")).toBeNull();
  });

  // #4690: a restored question shows the files sent with it as the chips a
  // live question shows, each opening the stored file in a new tab.
  it("shows the files sent with a restored question as the chips it showed when sent", async () => {
    loadAssistantThread.mockResolvedValue(
      loaded(withFiles(RECORDED, [CHART, BUDGET])),
    );
    await openFlyout();

    const sent = await screen.findByTestId("assistant-sent-attachments");
    // In the order they were uploaded, each named as it was sent.
    expect(
      within(sent)
        .getAllByTestId("assistant-attachment-link")
        .map((link) => link.textContent),
    ).toEqual(["chart.png", "budget.pdf"]);
    const chart = within(sent).getByRole("link", {
      name: "Open chart.png in a new tab",
    });
    expect(chart).toHaveAttribute(
      "href",
      "/api/v1/acme/core-platform/assistant/attachments/gen_01k9chart",
    );
    expect(chart).toHaveAttribute("target", "_blank");
    expect(
      within(sent).getByRole("link", { name: "Open budget.pdf in a new tab" }),
    ).toHaveAttribute(
      "href",
      "/api/v1/acme/core-platform/assistant/attachments/gen_01k9budget",
    );
    // A sent file cannot be removed, and nothing waits on the composer.
    expect(within(sent).queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("assistant-attachments")).toBeNull();
    await expectNoAxe(sent);
  });

  it("draws no file row under a restored question sent without files (negative)", async () => {
    await openFlyout();
    await screen.findByText("what is live?");
    expect(screen.queryByTestId("assistant-sent-attachments")).toBeNull();
    expect(screen.queryByTestId("assistant-attachment-link")).toBeNull();
  });

  // The thread read files the thread under the workspace's id, which holds
  // no slugs, so the cards take the slugs of the workspace on screen.
  it("draws a read-back thread's parked writes as cards for its workspace and run", async () => {
    await openFlyout();
    expect(await screen.findByTestId("parked-cards")).toBeTruthy();
    expect(parkedApprovals).toHaveBeenLastCalledWith({
      org: "acme",
      ws: "core-platform",
      runId: "arun_01k9",
      cards: RECORDED.messages[1]?.parked,
    });
  });

  it("reads the thread once and continues its conversation by its public id", async () => {
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await ask(user, "and now?");

    expect(askAssistant).toHaveBeenCalledWith("acme", "core-platform", {
      conversationId: "cnv_01k9x2",
      content: "and now?",
      route: "fleet",
      turnId: A_TURN_ID,
      entityId: null,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("assistant-answer")).toHaveLength(2);
    });
    expect(loadAssistantThread).toHaveBeenCalledTimes(1);
  });

  it("shows the intro when the person has no thread yet", async () => {
    loadAssistantThread.mockResolvedValue(loaded(null));
    await openFlyout();
    await waitFor(() => {
      expect(
        screen.getByTestId("assistant-thread-status"),
      ).not.toHaveTextContent("Loading");
    });
    expect(screen.getByTestId("assistant-intro")).toBeTruthy();
    expect(screen.getByTestId("assistant-new-thread")).toBeDisabled();
  });

  it("says the read is out, and keeps a question asked meanwhile in its own conversation", async () => {
    let answer: (value: unknown) => void = () => undefined;
    loadAssistantThread.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { user } = await openFlyout();
    expect(screen.getByTestId("assistant-thread-status")).toHaveTextContent(
      "Loading your last thread",
    );
    await ask(user, "quick question");
    await screen.findByTestId("assistant-answer");

    await act(async () => {
      answer(loaded(RECORDED));
      await Promise.resolve();
    });

    // The question the person asked stays on screen, and the recorded thread
    // does not replace it.
    expect(screen.getByText("quick question")).toBeTruthy();
    expect(screen.queryByText("what is live?")).toBeNull();
    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      conversationId: null,
    });
  });

  it("says a failed read failed, keeps the composer, and reads again on the next open (negative)", async () => {
    loadAssistantThread.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "control_plane_unavailable",
    });
    const { user } = await openFlyout();
    expect(
      await screen.findByText(/Your last thread could not be loaded/),
    ).toBeTruthy();
    expect(screen.getByTestId("assistant-composer")).not.toBeDisabled();

    loadAssistantThread.mockResolvedValue(loaded(RECORDED));
    await user.click(screen.getByRole("button", { name: "Close stella" }));
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    expect(await screen.findByText("what is live?")).toBeTruthy();
    expect(loadAssistantThread).toHaveBeenCalledTimes(2);
  });

  it("is accessible with a restored thread", async () => {
    await openFlyout();
    await screen.findByText("what is live?");
    await expectNoAxe(screen.getByTestId("assistant-flyout"));
  });
});

describe("the assistant's thread across a workspace rename (#3313)", () => {
  it("keeps the thread when the workspace's slug changes", async () => {
    const { renavigate } = await openFlyout();
    await screen.findByText("what is live?");

    // The renamed workspace reads as the same workspace id.
    loadAssistantThread.mockResolvedValue(loaded(null));
    renavigate("/acme/core-renamed");

    await waitFor(() => {
      expect(loadAssistantThread).toHaveBeenLastCalledWith(
        "acme",
        "core-renamed",
      );
    });
    expect(await screen.findByText("what is live?")).toBeTruthy();
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
  });

  it("lands a reply asked before a rename under the new slug, and frees the composer", async () => {
    let settle: (value: unknown) => void = () => undefined;
    askAssistant.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { user, renavigate } = await openFlyout();
    await screen.findByText("what is live?");
    await ask(user, "raise the budget");
    expect(screen.getByTestId("assistant-composer")).toBeDisabled();

    renavigate("/acme/core-renamed");
    await waitFor(() => {
      expect(loadAssistantThread).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      settle(turn({ reply: "That write waits on a person." }));
      await Promise.resolve();
    });

    expect(screen.getByText("raise the budget")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getAllByTestId("assistant-answer").at(-1),
      ).toHaveTextContent("That write waits on a person.");
    });
    expect(screen.getByTestId("assistant-composer")).not.toBeDisabled();
  });

  it("does not show one workspace's thread in another (negative)", async () => {
    const { renavigate } = await openFlyout();
    await screen.findByText("what is live?");

    loadAssistantThread.mockResolvedValue(
      loaded(null, "7b000000-0000-4000-8000-000000000002"),
    );
    renavigate("/acme/payments");
    await waitFor(() => {
      expect(screen.getByTestId("assistant-intro")).toBeTruthy();
    });
    expect(screen.queryByText("what is live?")).toBeNull();
  });
});

describe("New session", () => {
  it("empties the thread and opens a new conversation with the next question", async () => {
    const { user } = await openFlyout();
    await screen.findByText("what is live?");

    await user.click(screen.getByTestId("assistant-new-thread"));

    expect(screen.queryByText("what is live?")).toBeNull();
    expect(screen.getByTestId("assistant-intro")).toBeTruthy();
    expect(screen.getByTestId("assistant-new-thread")).toBeDisabled();

    await ask(user, "fresh start");
    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      conversationId: null,
      content: "fresh start",
    });
    // Nothing is deleted: the old conversation stays on the record, and the
    // flyout does not read it again.
    expect(loadAssistantThread).toHaveBeenCalledTimes(1);
  });

  it("keeps what the person has typed", async () => {
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await user.type(screen.getByTestId("assistant-composer"), "half typed");
    await user.click(screen.getByTestId("assistant-new-thread"));
    expect(screen.getByTestId("assistant-composer")).toHaveValue("half typed");
  });

  it("cannot start a new session while a turn is in flight (negative)", async () => {
    askAssistant.mockReturnValue(new Promise(() => undefined));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await ask(user, "still thinking?");
    expect(screen.getByTestId("assistant-new-thread")).toBeDisabled();
  });

  it("a new session started before the read answers is not replaced by it", async () => {
    let answer: (value: unknown) => void = () => undefined;
    loadAssistantThread.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { user } = await openFlyout();
    await ask(user, "first");
    await screen.findByTestId("assistant-answer");
    await user.click(screen.getByTestId("assistant-new-thread"));

    await act(async () => {
      answer(loaded(RECORDED));
      await Promise.resolve();
    });

    expect(screen.queryByText("what is live?")).toBeNull();
    expect(screen.getByTestId("assistant-intro")).toBeTruthy();
  });
});

const listed = (...sessions: Record<string, unknown>[]) => ({
  ok: true,
  value: sessions,
});

/** The restored thread's own row, and an older one with no title. */
const SESSIONS = [
  {
    id: "cnv_01k9x2",
    title: "what is live?",
    updatedAt: "2026-09-25T10:00:00.000Z",
  },
  { id: "cnv_01k8aa", title: null, updatedAt: "2026-09-21T08:30:00.000Z" },
];

const OLDER: AssistantThread = {
  id: "cnv_01k8aa",
  messages: [
    {
      id: "msg_b1",
      role: "user",
      text: "which budget is closest to its cap?",
      runId: null,
      parked: [],
      toolCalls: [],
      stopped: false,
      attachments: [],
    },
    {
      id: "msg_b2",
      role: "assistant",
      text: "The staging budget is at 92 percent.",
      runId: "arun_01k8",
      parked: [],
      toolCalls: [],
      stopped: false,
      attachments: [],
    },
  ],
  truncated: false,
};

describe("the session list (#4435)", () => {
  it("lists the person's sessions and marks the one on screen", async () => {
    listAssistantSessions.mockResolvedValue(listed(...SESSIONS));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");

    const toggle = screen.getByTestId("assistant-sessions-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(listAssistantSessions).toHaveBeenCalledWith("acme", "core-platform");
    const rows = await screen.findAllByTestId("assistant-session");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).toHaveTextContent("what is live?");
    expect(rows[0]).toHaveTextContent("Current");
    expect(rows[1]).not.toHaveAttribute("aria-current");
    expect(rows[1]).toHaveTextContent("Untitled thread");
    // The thread steps aside while the list shows.
    expect(screen.getByTestId("assistant-thread-view")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByTestId("assistant-sessions-view")).not.toHaveAttribute(
      "aria-hidden",
    );
  });

  it("opens a session, and the next question continues it", async () => {
    listAssistantSessions.mockResolvedValue(listed(...SESSIONS));
    openAssistantSession.mockResolvedValue({ ok: true, value: OLDER });
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await user.click(screen.getByTestId("assistant-sessions-toggle"));
    const rows = await screen.findAllByTestId("assistant-session");

    await user.click(nth(rows, 1, "the older session row"));

    expect(openAssistantSession).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "cnv_01k8aa",
    );
    expect(
      await screen.findByText("The staging budget is at 92 percent."),
    ).toBeTruthy();
    expect(screen.queryByText("Three runs are live.")).toBeNull();
    expect(screen.getByTestId("assistant-thread-view")).not.toHaveAttribute(
      "aria-hidden",
    );
    expect(screen.getByTestId("assistant-composer")).toHaveFocus();

    await ask(user, "and production?");
    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      conversationId: "cnv_01k8aa",
      content: "and production?",
    });
  });

  it("shows the files sent in a session it opens (#4690)", async () => {
    listAssistantSessions.mockResolvedValue(listed(...SESSIONS));
    openAssistantSession.mockResolvedValue({
      ok: true,
      value: withFiles(OLDER, [CHART]),
    });
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    expect(screen.queryByTestId("assistant-sent-attachments")).toBeNull();
    await user.click(screen.getByTestId("assistant-sessions-toggle"));
    const rows = await screen.findAllByTestId("assistant-session");

    await user.click(nth(rows, 1, "the older session row"));

    const sent = await screen.findByTestId("assistant-sent-attachments");
    expect(
      within(sent).getByRole("link", { name: "Open chart.png in a new tab" }),
    ).toHaveAttribute(
      "href",
      "/api/v1/acme/core-platform/assistant/attachments/gen_01k9chart",
    );
  });

  it("goes back to the thread from its own row without reading it again", async () => {
    listAssistantSessions.mockResolvedValue(listed(...SESSIONS));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await user.click(screen.getByTestId("assistant-sessions-toggle"));
    const rows = await screen.findAllByTestId("assistant-session");

    await user.click(nth(rows, 0, "the current session row"));

    expect(openAssistantSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("assistant-thread-view")).not.toHaveAttribute(
      "aria-hidden",
    );
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
  });

  it("reads the list again each time it is shown", async () => {
    listAssistantSessions.mockResolvedValue(listed(...SESSIONS));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    const toggle = screen.getByTestId("assistant-sessions-toggle");

    await user.click(toggle);
    await screen.findAllByTestId("assistant-session");
    await user.click(toggle);
    await user.click(toggle);

    await waitFor(() => {
      expect(listAssistantSessions).toHaveBeenCalledTimes(2);
    });
  });

  it("will not open another session while a turn is in flight (negative)", async () => {
    askAssistant.mockReturnValue(new Promise(() => undefined));
    listAssistantSessions.mockResolvedValue(listed(...SESSIONS));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await ask(user, "still thinking?");

    await user.click(screen.getByTestId("assistant-sessions-toggle"));
    const rows = await screen.findAllByTestId("assistant-session");

    expect(rows[1]).toBeDisabled();
    expect(rows[0]).not.toBeDisabled();
    expect(screen.getByTestId("assistant-sessions-status")).toHaveTextContent(
      "stella is answering",
    );
    expect(openAssistantSession).not.toHaveBeenCalled();
  });

  it("says when there are no sessions yet", async () => {
    loadAssistantThread.mockResolvedValue(loaded(null));
    listAssistantSessions.mockResolvedValue(listed());
    const { user } = await openFlyout();

    await user.click(screen.getByTestId("assistant-sessions-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("assistant-sessions-status")).toHaveTextContent(
        "No threads yet",
      );
    });
    expect(screen.queryByTestId("assistant-session")).toBeNull();
  });

  it("says a failed read failed, and Try again reads it again (negative)", async () => {
    listAssistantSessions.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "control_plane_unavailable",
    });
    listAssistantSessions.mockResolvedValueOnce(listed(...SESSIONS));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await user.click(screen.getByTestId("assistant-sessions-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("assistant-sessions-status")).toHaveTextContent(
        "Your threads could not be loaded.",
      );
    });
    await user.click(screen.getByTestId("assistant-sessions-retry"));

    expect(await screen.findAllByTestId("assistant-session")).toHaveLength(2);
    expect(listAssistantSessions).toHaveBeenCalledTimes(2);
  });

  it("says a session archived since the list was read is gone, and drops it (negative)", async () => {
    listAssistantSessions.mockResolvedValueOnce(listed(...SESSIONS));
    listAssistantSessions.mockResolvedValueOnce(listed(SESSIONS[0] ?? {}));
    openAssistantSession.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "conversation_not_found",
    });
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await user.click(screen.getByTestId("assistant-sessions-toggle"));
    const rows = await screen.findAllByTestId("assistant-session");

    await user.click(nth(rows, 1, "the older session row"));

    expect(
      await screen.findByTestId("assistant-sessions-open-failed"),
    ).toHaveTextContent("That thread was archived or deleted.");
    await waitFor(() => {
      expect(screen.getAllByTestId("assistant-session")).toHaveLength(1);
    });
    // The thread on screen is left as it was.
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
  });

  it("is accessible with the list shown", async () => {
    listAssistantSessions.mockResolvedValue(listed(...SESSIONS));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await user.click(screen.getByTestId("assistant-sessions-toggle"));
    await screen.findAllByTestId("assistant-session");
    await expectNoAxe(screen.getByTestId("assistant-flyout"));
  });
});

describe("a question in an archived session", () => {
  it("says the session is gone, and Ask again opens a new conversation (negative)", async () => {
    askAssistant.mockResolvedValueOnce({
      ok: false,
      reason: "not_found",
      code: "conversation_not_found",
    });
    const { user } = await openFlyout();
    await screen.findByText("what is live?");

    await ask(user, "still there?");

    expect(
      await screen.findByText(/This thread was archived or deleted/),
    ).toBeTruthy();
    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      conversationId: "cnv_01k9x2",
    });

    await user.click(screen.getByTestId("assistant-retry"));

    await waitFor(() => {
      expect(askAssistant).toHaveBeenCalledTimes(2);
    });
    expect(askAssistant.mock.calls[1]?.[2]).toMatchObject({
      conversationId: null,
      content: "still there?",
    });
  });
});
