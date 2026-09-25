// @vitest-environment jsdom
// The flyout's engine line (#3227) over a fake engine read: stella's engine is
// read when the panel opens, and while it reports any state but ready the
// flyout says so above the composer, holds Send with that sentence as its
// description, and keeps the draft. Check again, a window focus once the
// answer is 15 seconds old, and a turn the engine refused each read it again,
// and a recovered engine gives Send back. A read that fails holds nothing.
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
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
import { engineRead } from "./shell.builders";
import { ShellStateProvider, useShellState } from "./shell-state";

// The turn's transport (assistant-stream-client.ts) answers in the shape the
// Server Action it replaced did, so these cases drive it through one fake
// that takes the same three arguments. What arrives while a turn streams is
// assistant-flyout.streaming.test.tsx.
const askAssistant =
  vi.fn<(org: string, ws: string, question: unknown) => Promise<unknown>>();
vi.mock("./assistant-stream-client", () => ({
  askAssistantStream: (org: string, ws: string, question: unknown) =>
    askAssistant(org, ws, question),
}));
vi.mock("./assistant-actions", () => ({ readAssistantReply: vi.fn() }));
const readAssistantEngine = vi.fn();
vi.mock("./engine-actions", () => ({ readAssistantEngine }));

const pathname = vi.fn(() => "/acme/core-platform");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");
const { ENGINE_HEALTH_TTL_MS, useEngineHealth } = await import(
  "./use-engine-health"
);

/** Opens and closes the panel the way the launcher does. */
function Toggle() {
  const { assistantOpen, setAssistantOpen } = useShellState();
  return (
    <button
      type="button"
      onClick={() => {
        setAssistantOpen(!assistantOpen);
      }}
    >
      toggle assistant
    </button>
  );
}

async function openFlyout() {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <Toggle />
        <AssistantFlyout />
      </ShellStateProvider>
    </IntlProvider>,
  );
  const toggle = () =>
    user.click(screen.getByRole("button", { name: "toggle assistant" }));
  await toggle();
  return { user, toggle, flyout: screen.getByTestId("assistant-flyout") };
}

const composer = () => screen.getByTestId("assistant-composer");
const sendButton = () => screen.getByTestId("assistant-send");

const turn = {
  ok: true,
  value: {
    conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
    runId: "arun_01k9",
    reply: "Three runs are live.",
    parkedCards: [],
    stopped: false,
  },
};

const down = engineRead({ state: "unreachable", error: "ECONNREFUSED" });

/** A read that answers when the test says so. */
function deferred() {
  let settle: (value: unknown) => void = () => undefined;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

// The clock the cache is timed against. The panel's own reveal and focus code
// never reads it, so moving it moves nothing but the cache.
let now = Date.parse("2026-09-25T09:00:00Z");

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  now = Date.parse("2026-09-25T09:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  pathname.mockReturnValue("/acme/core-platform");
  askAssistant.mockReset();
  askAssistant.mockResolvedValue(turn);
  readAssistantEngine.mockReset();
  readAssistantEngine.mockResolvedValue(engineRead());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the engine line above the composer", () => {
  it("up: reads the engine once on open, draws no line and sends", async () => {
    const { user, flyout } = await openFlyout();

    await waitFor(() => {
      expect(readAssistantEngine).toHaveBeenCalledWith("acme", "core-platform");
    });
    expect(screen.queryByTestId("assistant-engine-down")).toBeNull();

    await user.type(composer(), "what is live?");
    expect(sendButton()).not.toHaveAttribute("aria-disabled");
    expect(sendButton()).not.toHaveAttribute("aria-describedby");
    await user.click(sendButton());

    await screen.findByTestId("assistant-answer");
    expect(askAssistant).toHaveBeenCalledTimes(1);
    expect(readAssistantEngine).toHaveBeenCalledTimes(1);
    await expectNoAxe(flyout);
  });

  it("down: names the state above the composer, holds Send with that reason, and keeps the draft (negative)", async () => {
    readAssistantEngine.mockResolvedValue(down);
    const { user, flyout } = await openFlyout();

    const line = await screen.findByTestId("assistant-engine-unreachable");
    expect(line).toHaveTextContent("stella’s engine could not be reached.");
    expect(line).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("assistant-engine-code")).toHaveTextContent(
      "ECONNREFUSED",
    );
    // Above the composer, in reading order.
    expect(
      line.compareDocumentPosition(composer()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.type(composer(), "what is live?");
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");
    expect(sendButton()).toHaveAccessibleDescription(
      "stella’s engine could not be reached. Send is off until it answers.",
    );

    await user.click(sendButton());
    await user.keyboard("{Enter}");
    expect(askAssistant).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("what is live?");
    await expectNoAxe(flyout);
  });

  it("recovered: Check again reads past the cache, gives Send back and returns focus to the draft", async () => {
    readAssistantEngine.mockResolvedValueOnce(down);
    readAssistantEngine.mockResolvedValueOnce(engineRead());
    const { user, flyout } = await openFlyout();
    await screen.findByTestId("assistant-engine-unreachable");
    await user.type(composer(), "what is live?");

    // Well inside the 15 seconds an open or a focus would wait.
    now += 1_000;
    await user.click(screen.getByTestId("assistant-engine-check"));

    await waitFor(() => {
      expect(screen.queryByTestId("assistant-engine-down")).toBeNull();
    });
    expect(readAssistantEngine).toHaveBeenCalledTimes(2);
    expect(sendButton()).not.toHaveAttribute("aria-disabled");
    expect(sendButton()).not.toHaveAttribute("aria-describedby");
    expect(composer()).toHaveValue("what is live?");
    expect(composer()).toHaveFocus();

    await user.click(sendButton());
    await screen.findByTestId("assistant-answer");
    expect(askAssistant.mock.calls[0]?.[2]).toMatchObject({
      content: "what is live?",
    });
    await expectNoAxe(flyout);
  });

  it("recovered: a window focus reads again once the answer is 15 seconds old, and not before", async () => {
    readAssistantEngine.mockResolvedValueOnce(down);
    readAssistantEngine.mockResolvedValueOnce(engineRead());
    const { user } = await openFlyout();
    await screen.findByTestId("assistant-engine-unreachable");
    await user.type(composer(), "what is live?");

    now += ENGINE_HEALTH_TTL_MS - 1;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(readAssistantEngine).toHaveBeenCalledTimes(1);

    now += 1;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("assistant-engine-down")).toBeNull();
    });
    expect(readAssistantEngine).toHaveBeenCalledTimes(2);
    expect(sendButton()).not.toHaveAttribute("aria-disabled");
    expect(composer()).toHaveValue("what is live?");
  });

  it("reads once however often the panel opens inside 15 seconds", async () => {
    const { toggle } = await openFlyout();
    await waitFor(() => {
      expect(readAssistantEngine).toHaveBeenCalledTimes(1);
    });

    await toggle();
    await toggle();
    expect(readAssistantEngine).toHaveBeenCalledTimes(1);

    now += ENGINE_HEALTH_TTL_MS;
    await toggle();
    await toggle();
    await waitFor(() => {
      expect(readAssistantEngine).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    ["starting", null, "stella’s engine is starting."],
    ["draining", null, "takes no new questions"],
    ["unconfigured", "engine_unavailable", "names no engine for stella"],
  ] as const)(
    "names the %s state and holds Send (negative)",
    async (state, error, phrase) => {
      readAssistantEngine.mockResolvedValue(engineRead({ state, error }));
      const { flyout } = await openFlyout();

      expect(
        await screen.findByTestId(`assistant-engine-${state}`),
      ).toHaveTextContent(phrase);
      expect(screen.queryByTestId("assistant-engine-code") !== null).toBe(
        error !== null,
      );
      expect(sendButton()).toHaveAttribute("aria-disabled", "true");
      await expectNoAxe(flyout);
    },
  );

  it("holds nothing on a read that failed or was refused, so the turn says what it finds", async () => {
    readAssistantEngine.mockRejectedValueOnce(new Error("network"));
    readAssistantEngine.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "workspace.read",
    });
    const { user, toggle } = await openFlyout();
    await waitFor(() => {
      expect(readAssistantEngine).toHaveBeenCalledTimes(1);
    });

    // A failed read is not cached: the next open reads again.
    await toggle();
    await toggle();
    await waitFor(() => {
      expect(readAssistantEngine).toHaveBeenCalledTimes(2);
    });

    expect(screen.queryByTestId("assistant-engine-down")).toBeNull();
    await user.type(composer(), "what is live?");
    await user.click(sendButton());
    await screen.findByTestId("assistant-answer");
  });

  it("keeps the last answer when a check fails, and says so while it runs", async () => {
    readAssistantEngine.mockResolvedValueOnce(down);
    const { user } = await openFlyout();
    await screen.findByTestId("assistant-engine-unreachable");

    const pending = deferred();
    readAssistantEngine.mockReturnValueOnce(pending.promise);
    const check = screen.getByTestId("assistant-engine-check");
    await user.click(check);
    expect(check).toHaveTextContent("Checking…");
    expect(check).toHaveAttribute("aria-disabled", "true");
    // A second press, and a focus past the cache, join the read that is out.
    await user.click(check);
    now += ENGINE_HEALTH_TTL_MS;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(readAssistantEngine).toHaveBeenCalledTimes(2);

    const refused = { ok: false, reason: "unavailable", code: "kernel_down" };
    await act(async () => {
      pending.settle(refused);
      await pending.promise;
    });
    expect(check).toHaveTextContent("Check again");
    expect(screen.getByTestId("assistant-engine-unreachable")).toBeTruthy();
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("reads the engine again when a turn comes back refused for it, and holds Ask again", async () => {
    askAssistant.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "engine_unavailable",
    });
    const { user } = await openFlyout();
    await waitFor(() => {
      expect(readAssistantEngine).toHaveBeenCalledTimes(1);
    });
    readAssistantEngine.mockResolvedValue(down);

    await user.type(composer(), "what is live?");
    await user.click(sendButton());

    await screen.findByTestId("assistant-engine");
    await screen.findByTestId("assistant-engine-unreachable");
    expect(readAssistantEngine).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("assistant-retry")).toBeDisabled();
  });

  it("reads nothing on an organization page, which offers no composer (negative)", async () => {
    pathname.mockReturnValue("/acme/billing");
    await openFlyout();

    expect(screen.getByTestId("assistant-needs-workspace")).toBeTruthy();
    expect(readAssistantEngine).not.toHaveBeenCalled();
  });
});

describe("useEngineHealth", () => {
  it("answers nothing and reads nothing outside a workspace (negative)", async () => {
    const { result } = renderHook(() => useEngineHealth("acme", null, true));

    expect(result.current.down).toBeNull();
    expect(await result.current.check()).toBe(false);
    expect(readAssistantEngine).not.toHaveBeenCalled();
  });
});
