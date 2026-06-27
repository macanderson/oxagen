/**
 * Proof of the Claude Code-style prompt queue in the interactive REPL.
 *
 * The agent loop (`runAgent`) is replaced with a controllable mock so each turn
 * stays "in flight" until the test resolves it. We drive the real <ReplApp/>
 * through ink-testing-library's stdin and assert that prompts submitted while a
 * turn is running are (a) visibly queued, (b) not started early, and (c) run in
 * FIFO order as each prior turn completes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

interface RunAgentResultLike {
  text: string;
  steps: number;
  messages: unknown[];
  usage: Record<string, number>;
}

// Each runAgent call parks here until the test resolves it, simulating a turn
// that takes real wall-clock time (so later submissions have to queue).
const pending: Array<{ prompt: string; finish: () => void }> = [];
const runAgentSpy = vi.fn<(opts: { prompt: string }) => void>();

vi.mock("../../agent/loop.js", () => ({
  runAgent: (opts: { prompt: string }) =>
    new Promise<RunAgentResultLike>((resolve) => {
      runAgentSpy(opts);
      pending.push({
        prompt: opts.prompt,
        finish: () =>
          resolve({
            text: `done:${opts.prompt}`,
            steps: 1,
            messages: [],
            usage: {},
          }),
      });
    }),
  MissingGatewayKeyError: class extends Error {},
}));

vi.mock("../../agent/memory.js", () => ({
  openSessionMemory: async () => ({
    remember: async () => {},
    recallContext: async () => "",
    close: async () => {},
  }),
}));

vi.mock("../../agent/project-context.js", () => ({
  loadProjectContext: () => ({ text: "", sources: [] }),
}));

vi.mock("../../agent/model.js", () => ({
  resolveModelId: (override?: string) => override ?? "test/model",
}));

const { ReplApp } = await import("../interactive.js");

const tick = (ms = 15): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition timed out");
    await tick(5);
  }
}

/** Type `text` then press Enter into the REPL's stdin. */
async function submit(
  stdin: { write: (s: string) => void },
  text: string,
): Promise<void> {
  stdin.write(text);
  await tick();
  stdin.write("\r");
  await tick();
}

describe("REPL prompt queue (Claude Code-style)", () => {
  beforeEach(() => {
    pending.length = 0;
    runAgentSpy.mockClear();
  });

  it("queues prompts submitted mid-turn and runs them FIFO", async () => {
    const { stdin, lastFrame } = render(<ReplApp options={{}} />);
    await tick();

    // 1) First prompt starts a turn; runAgent is invoked and parks (in flight).
    await submit(stdin, "first task");
    await waitFor(() => runAgentSpy.mock.calls.length === 1);
    expect(runAgentSpy.mock.calls[0]?.[0].prompt).toBe("first task");

    // 2) Submit two more WHILE the first turn is still running.
    await submit(stdin, "second task");
    await submit(stdin, "third task");

    // They must NOT have started — only the first turn is running.
    expect(runAgentSpy).toHaveBeenCalledTimes(1);

    // And they must be visibly queued in the UI.
    const queuedFrame = lastFrame() ?? "";
    expect(queuedFrame).toContain("queued");
    expect(queuedFrame).toContain("second task");
    expect(queuedFrame).toContain("third task");

    // 3) Finish the first turn → the next queued prompt auto-runs.
    pending[0]?.finish();
    await waitFor(() => runAgentSpy.mock.calls.length === 2);
    expect(runAgentSpy.mock.calls[1]?.[0].prompt).toBe("second task");

    // 4) Finish the second → the third runs, preserving order.
    pending[1]?.finish();
    await waitFor(() => runAgentSpy.mock.calls.length === 3);
    expect(runAgentSpy.mock.calls[2]?.[0].prompt).toBe("third task");

    // 5) Finish the third → queue fully drained, nothing else runs.
    pending[2]?.finish();
    await tick(30);
    expect(runAgentSpy).toHaveBeenCalledTimes(3);
    expect(lastFrame() ?? "").not.toContain("queued");
  });

  it("runs a prompt immediately when idle (no queue wait)", async () => {
    const { stdin } = render(<ReplApp options={{}} />);
    await tick();

    await submit(stdin, "solo task");
    await waitFor(() => runAgentSpy.mock.calls.length === 1);
    expect(runAgentSpy.mock.calls[0]?.[0].prompt).toBe("solo task");

    // Nothing queued behind it.
    pending[0]?.finish();
    await tick(30);
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
  });
});
