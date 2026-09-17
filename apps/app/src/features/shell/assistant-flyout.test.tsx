// @vitest-environment jsdom
// The assistant flyout over a fake turn action: that it asks and shows the
// reply, carries the conversation across turns, names the run each turn was
// recorded as, surfaces parked writes rather than swallowing them, reads each
// refusal, and offers no composer outside a workspace.
//
// The flyout WL-06 deleted had a `disabled` textarea, so the assertion that
// earns this file is the first one: a composer that reaches ask_assistant.
import { cleanup, render, screen } from "@testing-library/react";
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

const askAssistant = vi.fn();
vi.mock("./assistant-actions", () => ({ askAssistant }));

const pathname = vi.fn(() => "/acme/core-platform");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

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

async function openFlyout() {
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
  return { user, flyout: screen.getByTestId("assistant-flyout") };
}

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

  it("has no axe violations", async () => {
    const { flyout } = await openFlyout();
    await expectNoAxe(flyout);
  });
});
