// @vitest-environment jsdom
// What a reply cost, under the reply (#4167). The flyout reads the run each
// turn was recorded as through `readReplyCost` and prints what the record
// says: a recorded cost with the models the rollup priced, "pending" until
// metering lands, one more read after REPLY_COST_REREAD_MS and none after
// it, and a zero the rollup recorded as a zero, never as pending. The line's
// other readings and the action itself, over a stubbed kernel, follow.
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
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
import type { ReplyCost } from "./assistant-actions";
import { ShellStateProvider, useShellState } from "./shell-state";

const {
  askAssistantStream,
  readAssistantReply,
  readReplyCost,
  kernelRead,
  requireViewer,
} = vi.hoisted(() => ({
  askAssistantStream: vi.fn(),
  readAssistantReply: vi.fn(),
  readReplyCost: vi.fn(),
  kernelRead: vi.fn(),
  requireViewer: vi.fn(),
}));
// The turn streams over the API's chat stream (assistant-stream-client.ts);
// the reply read and the cost read are the Server Actions.
vi.mock("./assistant-stream-client", () => ({ askAssistantStream }));
vi.mock("./assistant-actions", () => ({ readAssistantReply, readReplyCost }));
// The action's own seams, for the real `readReplyCost` read at the bottom.
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelRead,
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");
const { AssistantReplyCost } = await import("./assistant-reply-cost");
// The hook's re-read delay (`use-reply-cost.ts`), stated here rather than
// exported from the module: the hook is its only production reader.
const REPLY_COST_REREAD_MS = 60_000;
const actual = await vi.importActual<typeof import("./assistant-actions")>(
  "./assistant-actions",
);

type Recorded = Extract<ReplyCost, { kind: "recorded" }>;

const PENDING = { ok: true, value: { kind: "pending" } };

function recorded(over: Partial<Recorded> = {}) {
  return {
    ok: true,
    value: {
      kind: "recorded",
      cost: { micros: "4213", currency: "USD", basis: "gateway_observed" },
      models: ["anthropic/claude-sonnet-4.5"],
      estimate: false,
      incomplete: false,
      ...over,
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

/** Open the flyout, ask one question, and hand back the answer's cost line. */
async function askOnce() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AssistantFlyout />
      </ShellStateProvider>
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  await user.type(screen.getByTestId("assistant-composer"), "what was that?");
  await user.click(screen.getByTestId("assistant-send"));
  return screen.findByTestId("assistant-reply-cost");
}

/** The line alone, for the readings the flyout test does not need a turn for. */
function renderLine() {
  render(
    <IntlProvider>
      <AssistantReplyCost scope="acme/core-platform" runId="arun_02" />
    </IntlProvider>,
  );
  return screen.getByTestId("assistant-reply-cost");
}

/** Wait until the line has settled on `state` after a read. */
async function settled(line: HTMLElement, state: string) {
  await waitFor(() => {
    expect(line).toHaveAttribute("data-state", state);
  });
}

/** Move the clock past the one re-read and let it answer. */
async function passReread() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REPLY_COST_REREAD_MS);
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
  // Only the timers: the clock still moves with real time, so the queries
  // that wait keep working, and a test jumps it to the re-read on purpose.
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "clearTimeout"],
  });
  askAssistantStream.mockReset();
  readAssistantReply.mockReset();
  readReplyCost.mockReset();
  kernelRead.mockReset();
  requireViewer.mockReset();
  askAssistantStream.mockResolvedValue({
    ok: true,
    value: {
      conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
      runId: "arun_01k9",
      reply: "Three runs are live.",
      parkedCards: [],
      toolCalls: [],
      stopped: false,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the cost under a reply", () => {
  it("prints the recorded cost and the models the rollup priced, read in the thread's workspace", async () => {
    readReplyCost.mockResolvedValue(recorded());
    const line = await askOnce();
    await settled(line, "recorded");

    // Exact precision: a fraction of a cent rounded to cents would read $0.00.
    // The ordinary basis is not printed.
    expect(line.textContent).toBe(
      "cost $0.004213 · anthropic/claude-sonnet-4.5",
    );
    expect(screen.getByTestId("assistant-answer")).toContainElement(line);
    expect(line).toHaveAttribute("aria-live", "off");
    expect(readReplyCost).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_01k9",
    );
    // A recorded cost is what the record says: nothing reads it again.
    await passReread();
    expect(readReplyCost).toHaveBeenCalledTimes(1);
    await expectNoAxe(screen.getByTestId("assistant-flyout"));
  });

  it("reads pending until metering lands, then the figure the re-read finds", async () => {
    readReplyCost
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(recorded());
    const line = await askOnce();
    await settled(line, "pending");

    expect(line.textContent).toBe("cost pending");
    expect(line).not.toHaveTextContent("$");
    expect(readReplyCost).toHaveBeenCalledTimes(1);

    await passReread();
    await settled(line, "recorded");
    expect(line.textContent).toBe(
      "cost $0.004213 · anthropic/claude-sonnet-4.5",
    );
    expect(readReplyCost).toHaveBeenCalledTimes(2);
  });

  it("stays pending when the re-read finds no row either, and reads no further", async () => {
    readReplyCost.mockResolvedValue(PENDING);
    const line = await askOnce();
    await settled(line, "pending");

    await passReread();
    expect(readReplyCost).toHaveBeenCalledTimes(2);
    expect(line).toHaveAttribute("data-state", "pending");
    expect(line.textContent).toBe("cost pending");

    // Ten more minutes: the line reads the record twice and then leaves it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * REPLY_COST_REREAD_MS);
    });
    expect(readReplyCost).toHaveBeenCalledTimes(2);
    expect(line.textContent).toBe("cost pending");
  });

  it("prints a zero the rollup recorded as zero, not as pending", async () => {
    readReplyCost.mockResolvedValue(
      recorded({
        cost: { micros: "0", currency: "USD", basis: "gateway_observed" },
      }),
    );
    const line = await askOnce();
    await settled(line, "recorded");

    expect(line.textContent).toBe("cost $0.00 · anthropic/claude-sonnet-4.5");
    expect(line).not.toHaveTextContent("pending");
  });

  // A stream that dropped keeps no cost line: the reply is not finished on
  // screen. Once the finished reply loads from the run, it carries that run,
  // and the line reads its cost.
  it("reads the cost of a dropped reply once it loads from the run", async () => {
    askAssistantStream.mockResolvedValue({
      ok: false,
      reason: "dropped",
      runId: "arun_01k9",
    });
    readAssistantReply.mockResolvedValue({
      ok: true,
      value: {
        state: "answered",
        conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
        reply: "Three runs are live.",
        stopped: false,
      },
    });
    readReplyCost.mockResolvedValue(recorded());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <IntlProvider>
        <ShellStateProvider>
          <OpenIt />
          <AssistantFlyout />
        </ShellStateProvider>
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    await user.type(screen.getByTestId("assistant-composer"), "what was that?");
    await user.click(screen.getByTestId("assistant-send"));
    const load = await screen.findByTestId("assistant-load-reply");
    expect(screen.queryByTestId("assistant-reply-cost")).toBeNull();
    await user.click(load);

    const line = await screen.findByTestId("assistant-reply-cost");
    await settled(line, "recorded");
    expect(readReplyCost).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_01k9",
    );
  });
});

describe("the line's other readings", () => {
  it("names a weaker basis, an estimate, unpriced calls, and every model priced", async () => {
    readReplyCost.mockResolvedValue(
      recorded({
        cost: { micros: "12500", currency: "USD", basis: "estimated" },
        models: ["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4.5"],
        estimate: true,
        incomplete: true,
      }),
    );
    const line = renderLine();
    await settled(line, "recorded");

    expect(line.textContent).toBe(
      "cost $0.0125 · estimated · estimate · some calls unpriced · anthropic/claude-sonnet-4.5, anthropic/claude-haiku-4.5",
    );
    expect(readReplyCost).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_02",
    );
    await expectNoAxe(line);
  });

  it("says a basis the record does not hold is not recorded", async () => {
    readReplyCost.mockResolvedValue(
      recorded({ cost: { micros: "4213", currency: "USD", basis: null } }),
    );
    const line = renderLine();
    await settled(line, "recorded");

    expect(line.textContent).toBe(
      "cost $0.004213 · basis not recorded · anthropic/claude-sonnet-4.5",
    );
  });

  it("says not recorded, never a zero, when the rollup priced no call", async () => {
    readReplyCost.mockResolvedValue(recorded({ cost: null, models: [] }));
    const line = renderLine();
    await settled(line, "recorded");

    expect(line.textContent).toBe("cost not recorded");
  });

  it("says the cost was not read when the action refuses, and reads it again once (negative)", async () => {
    readReplyCost
      .mockResolvedValueOnce({
        ok: false,
        reason: "unavailable",
        code: "control_plane_unavailable",
      })
      .mockResolvedValueOnce(recorded());
    const line = renderLine();
    await settled(line, "unread");
    expect(line.textContent).toBe("cost could not be read");

    await passReread();
    await settled(line, "recorded");
    expect(readReplyCost).toHaveBeenCalledTimes(2);
  });

  it("says the cost was not read when the action throws (negative)", async () => {
    readReplyCost.mockRejectedValue(new Error("network"));
    const line = renderLine();
    await settled(line, "unread");

    expect(line.textContent).toBe("cost could not be read");
  });

  it("keeps pending on screen when the re-read fails (negative)", async () => {
    readReplyCost
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce({ ok: false, reason: "denied", code: "run.read" });
    const line = renderLine();
    await settled(line, "pending");

    await passReread();
    expect(readReplyCost).toHaveBeenCalledTimes(2);
    expect(line).toHaveAttribute("data-state", "pending");
  });

  it("reads nothing more once the line is gone", async () => {
    readReplyCost.mockResolvedValue(PENDING);
    const line = renderLine();
    await settled(line, "pending");

    cleanup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPLY_COST_REREAD_MS);
    });
    expect(readReplyCost).toHaveBeenCalledTimes(1);
  });
});

describe("readReplyCost", () => {
  const ctx = { orgSlug: "acme", wsSlug: "core-platform" };

  beforeEach(() => {
    requireViewer.mockResolvedValue(ctx);
  });

  it("reads get_run_cost on the viewer the URL resolves, and answers pending while the run has no rollup", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { runId: "arun_01k9", rollup: null },
    });

    expect(
      await actual.readReplyCost("acme", "core-platform", "arun_01k9"),
    ).toEqual({ ok: true, value: { kind: "pending" } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runCostGet,
      input: { runId: "arun_01k9" },
      page: "shell",
    });
  });

  it("answers the rollup's cost, the models it priced, and whether the figure is partial", async () => {
    const cost = { micros: "4213", currency: "USD", basis: "gateway_observed" };
    kernelRead.mockResolvedValue({
      ok: true,
      value: {
        runId: "arun_01k9",
        rollup: {
          cost,
          isEstimate: true,
          byModel: [
            { model: "anthropic/claude-sonnet-4.5", hasUnpriced: false },
            { model: "anthropic/claude-haiku-4.5", hasUnpriced: true },
          ],
        },
      },
    });

    expect(
      await actual.readReplyCost("acme", "core-platform", "arun_01k9"),
    ).toEqual({
      ok: true,
      value: {
        kind: "recorded",
        cost,
        models: ["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4.5"],
        estimate: true,
        incomplete: true,
      },
    });
  });

  it("returns a refusal as the action's own (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "get_run_cost",
    });

    expect(
      await actual.readReplyCost("acme", "core-platform", "arun_01k9"),
    ).toEqual({ ok: false, reason: "denied", code: "get_run_cost" });
  });
});
