// @vitest-environment jsdom
// The assistant's thread across a reload, a workspace rename, and "New
// thread" (#4163, #3313). The turn action and the thread read are fakes: the
// read answers the thread the record holds and the workspace id the flyout
// files it under, so each case shows what the person sees.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
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
import { ShellStateProvider, useShellState } from "./shell-state";

const askAssistant = vi.fn();
vi.mock("./assistant-actions", () => ({ askAssistant }));
const loadAssistantThread = vi.fn();
vi.mock("./assistant-thread-actions", () => ({ loadAssistantThread }));

const pathname = vi.fn(() => "/acme/core-platform");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");

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
    },
  ],
  truncated: false,
};

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
    // A restored answer was read before: it is shown whole, not typed out.
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "Three runs are live.",
    );
    expect(screen.getByTestId("assistant-recorded-as")).toHaveTextContent(
      "recorded as arun_01k9",
    );
    expect(screen.getByTestId("assistant-parked")).toBeTruthy();
    expect(screen.queryByTestId("assistant-intro")).toBeNull();
  });

  it("reads the thread once and continues its conversation by its public id", async () => {
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await ask(user, "and now?");

    expect(askAssistant).toHaveBeenCalledWith("acme", "core-platform", {
      conversationId: "cnv_01k9x2",
      content: "and now?",
      route: "fleet",
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

describe("New thread", () => {
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

  it("cannot start a new thread while a turn is in flight (negative)", async () => {
    askAssistant.mockReturnValue(new Promise(() => undefined));
    const { user } = await openFlyout();
    await screen.findByText("what is live?");
    await ask(user, "still thinking?");
    expect(screen.getByTestId("assistant-new-thread")).toBeDisabled();
  });

  it("a new thread started before the read answers is not replaced by it", async () => {
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
