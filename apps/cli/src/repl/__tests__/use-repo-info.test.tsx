/**
 * Tests for the useRepoInfo hook — git-info.ts's synchronous resolver and
 * gh-pr.ts's async fetch are both mocked so these are fast and deterministic;
 * git-info.test.ts and gh-pr.test.ts cover those modules' own real behavior.
 * Driven through a tiny probe component + ink-testing-library, matching how
 * the rest of this REPL's hooks are tested (see prompt-input-*.test.tsx).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";

const resolveGitInfoMock = vi.fn();
vi.mock("../git-info.js", () => ({
  resolveGitInfo: (...args: unknown[]) => resolveGitInfoMock(...args),
  truncatePathStart: (p: string) => p,
}));

const fetchPrNumberMock = vi.fn();
vi.mock("../gh-pr.js", () => ({
  fetchPrNumber: (...args: unknown[]) => fetchPrNumberMock(...args),
}));

const { useRepoInfo } = await import("../use-repo-info.js");

function Probe({ cwd, enabled }: { cwd: string; enabled: boolean }): React.ReactElement {
  const info = useRepoInfo(cwd, enabled);
  return (
    <Text>
      {`root=${info.root} branch=${info.branch ?? "none"} pr=${info.prNumber === undefined ? "pending" : info.prNumber === null ? "null" : info.prNumber}`}
    </Text>
  );
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the rendered frame until it contains `needle`. The assertions that use
 * this are on state that arrives through a resolved promise and then an ink
 * re-render; sleeping a fixed 10ms and asserting once passed on a quiet machine
 * and lost the race on a loaded CI runner, which is how ci-nightly run
 * 32949930979 went red with the frame still reading `pr=pending`. On timeout it
 * reports the frame it gave up on, so a real regression says what it saw.
 */
async function waitForFrame(frame: () => string | undefined, needle: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(frame() ?? "").includes(needle)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForFrame: timed out waiting for ${JSON.stringify(needle)}; last frame was ${JSON.stringify(frame() ?? "")}`,
      );
    }
    await tick();
  }
}

beforeEach(() => {
  resolveGitInfoMock.mockReset();
  fetchPrNumberMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRepoInfo", () => {
  it("resolves git info synchronously on mount, before any PR data arrives", () => {
    resolveGitInfoMock.mockReturnValue({ root: "/repo", branch: "main" });
    fetchPrNumberMock.mockReturnValue(new Promise(() => {})); // never resolves in this test
    const { lastFrame, unmount } = render(<Probe cwd="/repo/sub" enabled={true} />);
    expect(lastFrame()).toContain("root=/repo");
    expect(lastFrame()).toContain("branch=main");
    expect(lastFrame()).toContain("pr=pending"); // still in flight — never blocks the initial render
    unmount();
  });

  it("falls back to cwd as root when outside a repo, and shows no branch", () => {
    resolveGitInfoMock.mockReturnValue(undefined);
    fetchPrNumberMock.mockReturnValue(Promise.resolve(null));
    const { lastFrame, unmount } = render(<Probe cwd="/not/a/repo" enabled={true} />);
    expect(lastFrame()).toContain("root=/not/a/repo");
    expect(lastFrame()).toContain("branch=none");
    unmount();
  });

  it("updates with the PR number once the async gh lookup resolves", async () => {
    resolveGitInfoMock.mockReturnValue({ root: "/repo", branch: "feat/x" });
    let resolveFetch: (n: number | null) => void = () => {};
    fetchPrNumberMock.mockReturnValue(new Promise<number | null>((r) => (resolveFetch = r)));

    const { lastFrame, unmount } = render(<Probe cwd="/repo" enabled={true} />);
    expect(lastFrame()).toContain("pr=pending");

    resolveFetch(123);
    await waitForFrame(lastFrame, "pr=123");
    unmount();
  });

  it("shows pr=null (never blocks) when there's no branch to look up", async () => {
    resolveGitInfoMock.mockReturnValue({ root: "/repo", branch: undefined });
    const { lastFrame, unmount } = render(<Probe cwd="/repo" enabled={true} />);
    await waitForFrame(lastFrame, "pr=null");
    expect(lastFrame()).toContain("branch=none");
    expect(fetchPrNumberMock).not.toHaveBeenCalled(); // never shells out for a branch-less repo
    unmount();
  });

  it("does nothing at all when disabled — no subprocess, no timer, static initial state", async () => {
    resolveGitInfoMock.mockReturnValue({ root: "/repo", branch: "main" });
    const { lastFrame, unmount } = render(<Probe cwd="/repo" enabled={false} />);
    await tick();
    // Still shows the ONE synchronous read from the initial useState — but no
    // effect ever ran, so the PR fetch (which only the effect kicks off) never fires.
    expect(fetchPrNumberMock).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("pr=pending");
    unmount();
  });

  it("never applies a PR result that resolves after the component unmounted", async () => {
    resolveGitInfoMock.mockReturnValue({ root: "/repo", branch: "feat/x" });
    let resolveFetch: (n: number | null) => void = () => {};
    fetchPrNumberMock.mockReturnValue(new Promise<number | null>((r) => (resolveFetch = r)));

    const { unmount } = render(<Probe cwd="/repo" enabled={true} />);
    unmount();
    resolveFetch(999); // resolves AFTER unmount
    await tick();
    // Nothing to assert on frames post-unmount — the real assertion is that
    // this doesn't throw an "update on an unmounted component" style error,
    // which vitest would surface as a failed test via an unhandled rejection
    // or console.error escalation.
  });
});
