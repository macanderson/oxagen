/**
 * Tests for the oxagen init animation orchestrator: does it choose the right
 * rendering path (TTY animation vs plain-line fallback), and does the TTY
 * path correctly block the domains hand-off until the reveal signals ready
 * before unmounting and letting runInit continue (e.g. into the workspace
 * linker) — the mechanism that keeps Ink's output and the linker's plain
 * stdout prompts from interleaving.
 *
 * ink's render is mocked (same pattern as
 * repl/__tests__/interactive.launch.test.tsx), so this exercises only
 * init-animation.tsx's own sequencing — not a real Ink render, which
 * init-animation-app.test.tsx already covers. The init engine's runInit is
 * mocked too, so this never touches the filesystem/duckdb/AI —
 * commands/__tests__/init.test.ts covers runInit itself.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { InitOptions, InitResult } from "../../commands/init-engine.js";

const { runInitMock, renderSpy, unmountMock, waitUntilExitMock } = vi.hoisted(
  () => ({
    runInitMock: vi.fn(),
    renderSpy: vi.fn(),
    unmountMock: vi.fn(),
    waitUntilExitMock: vi.fn(async () => undefined),
  }),
);

vi.mock("../../commands/init-engine.js", () => ({ runInit: runInitMock }));
vi.mock("ink", () => ({
  render: (node: unknown) => {
    renderSpy(node);
    return { unmount: unmountMock, waitUntilExit: waitUntilExitMock };
  },
}));

const { runInitWithAnimation } = await import("../init-animation.js");

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function renderedOnReady(): () => void {
  const element = renderSpy.mock.calls[0]?.[0] as
    | { props: { onReady: () => void } }
    | undefined;
  if (!element) throw new Error("ink.render was never called");
  return element.props.onReady;
}

const originalIsTTY = process.stdout.isTTY;
const originalFun = process.env["OXAGEN_CLI_FUN"];

afterEach(() => {
  setTTY(originalIsTTY);
  if (originalFun === undefined) delete process.env["OXAGEN_CLI_FUN"];
  else process.env["OXAGEN_CLI_FUN"] = originalFun;
  runInitMock.mockReset();
  renderSpy.mockReset();
  unmountMock.mockReset();
  waitUntilExitMock.mockReset();
  waitUntilExitMock.mockImplementation(async () => undefined);
  vi.restoreAllMocks();
});

const FIXED_RESULT: InitResult = {
  projectSettingsPath: "/tmp/.oxagen/settings.json",
  projectSettingsCreated: true,
  userSettingsPath: "/tmp/user-settings.json",
  userSettingsCreated: true,
  graph: {
    files: 3,
    totalSymbols: 5,
    totalEdges: 2,
    symbolsByKind: {},
    edgesByType: {},
    languages: [],
    indexed: 3,
    skipped: 0,
  },
  domains: [],
  domainsSkipped: false,
  workspaceLink: null,
};

describe("runInitWithAnimation — plain-line fallback", () => {
  it("falls back off a TTY: writes phase lines to stderr, never renders Ink", async () => {
    setTTY(false);
    runInitMock.mockImplementation(async (opts: InitOptions) => {
      await opts.onProgress?.({ phase: "graph", status: "start" });
      await opts.onProgress?.({
        phase: "domains",
        status: "done",
        domains: [{ name: "billing", files: 2 }],
      });
      return FIXED_RESULT;
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const result = await runInitWithAnimation({});

    expect(result).toBe(FIXED_RESULT);
    expect(renderSpy).not.toHaveBeenCalled();
    const lines = stderrSpy.mock.calls.map((c) => c[0]);
    expect(lines).toContain("Building code graph…\n");
    expect(lines).toContain("Domains: 1 found\n");
  });

  it("falls back when --json is set, even on a real TTY", async () => {
    setTTY(true);
    runInitMock.mockResolvedValue(FIXED_RESULT);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runInitWithAnimation({ json: true });

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("falls back when OXAGEN_CLI_FUN=0, even on a real TTY", async () => {
    setTTY(true);
    process.env["OXAGEN_CLI_FUN"] = "0";
    runInitMock.mockResolvedValue(FIXED_RESULT);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runInitWithAnimation({});

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("writes 'skipped' when domain inference is skipped", async () => {
    setTTY(false);
    runInitMock.mockImplementation(async (opts: InitOptions) => {
      await opts.onProgress?.({ phase: "domains", status: "skipped" });
      return FIXED_RESULT;
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await runInitWithAnimation({});

    expect(stderrSpy.mock.calls.map((c) => c[0])).toContain(
      "Domains: skipped\n",
    );
  });
});

describe("runInitWithAnimation — TTY animation hand-off", () => {
  it("renders the Ink app and blocks the domains boundary until the reveal signals ready", async () => {
    setTTY(true);
    delete process.env["OXAGEN_CLI_FUN"];

    let afterDomainsRan = false;
    runInitMock.mockImplementation(async (opts: InitOptions) => {
      await opts.onProgress?.({ phase: "graph", status: "start" });
      await opts.onProgress?.({
        phase: "domains",
        status: "done",
        domains: [],
      });
      afterDomainsRan = true; // only reachable once onProgress's await resolves
      return FIXED_RESULT;
    });

    const runPromise = runInitWithAnimation({});

    // Let the mocked runInit reach (and block inside) the domains boundary.
    await new Promise((r) => setTimeout(r, 20));
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(afterDomainsRan).toBe(false); // still blocked — reveal hasn't signalled ready
    expect(unmountMock).not.toHaveBeenCalled();

    // Simulate the reveal completing (what InitAnimationApp's onReady does).
    renderedOnReady()();
    const result = await runPromise;

    expect(afterDomainsRan).toBe(true);
    expect(unmountMock).toHaveBeenCalledTimes(1);
    expect(waitUntilExitMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(FIXED_RESULT);
  });

  it("hands off on a domains:skipped resolution the same as domains:done", async () => {
    setTTY(true);
    delete process.env["OXAGEN_CLI_FUN"];

    runInitMock.mockImplementation(async (opts: InitOptions) => {
      await opts.onProgress?.({ phase: "domains", status: "skipped" });
      return FIXED_RESULT;
    });

    const runPromise = runInitWithAnimation({});
    await new Promise((r) => setTimeout(r, 20));
    renderedOnReady()();
    await runPromise;

    expect(unmountMock).toHaveBeenCalledTimes(1);
  });

  it("does not hand off on domains:start — only a terminal domains status unblocks it", async () => {
    setTTY(true);
    delete process.env["OXAGEN_CLI_FUN"];

    runInitMock.mockImplementation(async (opts: InitOptions) => {
      await opts.onProgress?.({
        phase: "domains",
        status: "start",
        totalFiles: 4,
      });
      // If the orchestrator incorrectly unblocked on "start", this would hang
      // forever waiting on a reveal that never fires — the 20ms wait below
      // proves it does not.
      await opts.onProgress?.({
        phase: "domains",
        status: "done",
        domains: [],
      });
      return FIXED_RESULT;
    });

    const runPromise = runInitWithAnimation({});
    await new Promise((r) => setTimeout(r, 20));
    expect(unmountMock).not.toHaveBeenCalled();

    renderedOnReady()();
    await runPromise;
    expect(unmountMock).toHaveBeenCalledTimes(1);
  });

  it("tears the Ink app down on an error before the domains boundary, and rethrows", async () => {
    setTTY(true);
    delete process.env["OXAGEN_CLI_FUN"];

    const boom = new Error("settings scaffold failed");
    runInitMock.mockImplementation(async (opts: InitOptions) => {
      await opts.onProgress?.({ phase: "settings", status: "start" });
      throw boom;
    });

    await expect(runInitWithAnimation({})).rejects.toBe(boom);
    expect(unmountMock).toHaveBeenCalledTimes(1);
    expect(waitUntilExitMock).toHaveBeenCalledTimes(1);
  });
});
