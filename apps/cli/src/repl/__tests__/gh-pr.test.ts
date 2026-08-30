/**
 * Unit tests for gh-pr.ts's PR-number lookup — `node:child_process`'s
 * `execFile` is mocked so these run instantly and never actually shell out to
 * a real `gh` binary or the network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { fetchPrNumber, GH_PR_TIMEOUT_MS } = await import("../gh-pr.js");

/** Wires the mock's callback-style API: the last arg is `(err, stdout, stderr) => void`. */
function respondWith(err: Error | null, stdout = ""): void {
  execFileMock.mockImplementationOnce((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (
      e: Error | null,
      out: string,
      err: string,
    ) => void;
    cb(err, stdout, "");
  });
}

afterEach(() => {
  execFileMock.mockClear();
});

describe("fetchPrNumber", () => {
  it("resolves the PR number from a successful gh call", async () => {
    respondWith(null, "486\n");
    const result = await fetchPrNumber("/repo", "feat/x");
    expect(result).toBe(486);
  });

  it("invokes gh pr view with the branch and the expected json/jq flags", async () => {
    respondWith(null, "1\n");
    await fetchPrNumber("/repo", "feat/x");
    const [cmd, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "view",
      "feat/x",
      "--json",
      "number",
      "--jq",
      ".number",
    ]);
    expect(opts).toMatchObject({ cwd: "/repo", timeout: GH_PR_TIMEOUT_MS });
  });

  it("resolves null (never rejects) when gh exits with an error (no PR / not authenticated)", async () => {
    respondWith(new Error("no pull requests found for branch"));
    await expect(fetchPrNumber("/repo", "feat/x")).resolves.toBeNull();
  });

  it("resolves null when gh isn't installed (ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn gh ENOENT"), {
      code: "ENOENT",
    });
    respondWith(enoent);
    await expect(fetchPrNumber("/repo", "feat/x")).resolves.toBeNull();
  });

  it("resolves null on a timeout (execFile reports it as an error)", async () => {
    const timeoutErr = Object.assign(new Error("Command timed out"), {
      killed: true,
      signal: "SIGTERM",
    });
    respondWith(timeoutErr);
    await expect(fetchPrNumber("/repo", "feat/x")).resolves.toBeNull();
  });

  it("resolves null when stdout isn't a valid positive number", async () => {
    respondWith(null, "not-a-number\n");
    await expect(fetchPrNumber("/repo", "feat/x")).resolves.toBeNull();
    respondWith(null, "0\n");
    await expect(fetchPrNumber("/repo", "feat/x")).resolves.toBeNull();
    respondWith(null, "-3\n");
    await expect(fetchPrNumber("/repo", "feat/x")).resolves.toBeNull();
  });

  it("never throws synchronously and never rejects, even on garbage input", async () => {
    respondWith(null, "\n\n  \n");
    await expect(fetchPrNumber("/repo", "feat/x")).resolves.toBeNull();
  });
});
