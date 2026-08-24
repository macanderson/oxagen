/**
 * gh.test.ts — pins the shared `gh` invocation helper's contract: the
 * color-defeating env overlay (every mechanism `gh` respects is pinned off,
 * without mutating the base env), the exact execFile invocation runGh makes
 * (command, args, cwd/maxBuffer/env), error propagation with gh's stderr
 * intact, and ghJson's parse-stdout shape including its failure mode on
 * non-JSON output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { colorSafeEnv, ghJson, runGh } from "./gh.js";

/** `promisify(execFile)` on the plain mock (no promisify.custom symbol) treats
 * the last argument as the node-style callback — resolve through it. */
const execOk = (stdout: string, stderr = "") =>
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (e: unknown, r: { stdout: string; stderr: string }) => void,
    ) => {
      const done = typeof _opts === "function" ? (_opts as typeof cb) : cb;
      done?.(null, { stdout, stderr });
    },
  );

const execFail = (err: Error) =>
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (e: unknown, r?: unknown) => void,
    ) => {
      const done = typeof _opts === "function" ? (_opts as typeof cb) : cb;
      done?.(err);
    },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("colorSafeEnv", () => {
  it("overrides every color-forcing variable on an explicit base and keeps the rest", () => {
    const base = {
      PATH: "/usr/bin",
      CLICOLOR_FORCE: "1",
      FORCE_COLOR: "3",
      NO_COLOR: undefined,
    } as NodeJS.ProcessEnv;
    const env = colorSafeEnv(base);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["NO_COLOR"]).toBe("1");
    expect(env["CLICOLOR_FORCE"]).toBe("0");
    expect(env["CLICOLOR"]).toBe("0");
    expect(env["FORCE_COLOR"]).toBe("0");
    // The base is copied, never mutated.
    expect(base["CLICOLOR_FORCE"]).toBe("1");
    expect(base["FORCE_COLOR"]).toBe("3");
  });

  it("defaults the base to process.env (vitest pins FORCE_COLOR=3 there) and defeats it", () => {
    expect(process.env["FORCE_COLOR"]).toBe("3");
    const env = colorSafeEnv();
    expect(env["FORCE_COLOR"]).toBe("0");
    expect(env["PATH"]).toBe(process.env["PATH"]);
    // process.env itself is untouched.
    expect(process.env["FORCE_COLOR"]).toBe("3");
  });
});

describe("runGh", () => {
  it("invokes gh with the args, a color-safe env, and the 8MiB default maxBuffer", async () => {
    execOk("out text", "warn text");
    const result = await runGh(["pr", "list"]);
    expect(result).toEqual({ stdout: "out text", stderr: "warn text" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; maxBuffer: number; env: NodeJS.ProcessEnv },
    ];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "list"]);
    expect(options.cwd).toBeUndefined();
    expect(options.maxBuffer).toBe(8 * 1024 * 1024);
    expect(options.env["NO_COLOR"]).toBe("1");
    expect(options.env["CLICOLOR_FORCE"]).toBe("0");
    expect(options.env["CLICOLOR"]).toBe("0");
    expect(options.env["FORCE_COLOR"]).toBe("0");
    // The overlay rides on the real environment, not a bare one.
    expect(options.env["PATH"]).toBe(process.env["PATH"]);
  });

  it("threads cwd and a caller maxBuffer through to execFile", async () => {
    execOk("");
    await runGh(["status"], { cwd: "/tmp/repo", maxBuffer: 1024 });
    const [, , options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; maxBuffer: number },
    ];
    expect(options.cwd).toBe("/tmp/repo");
    expect(options.maxBuffer).toBe(1024);
  });

  it("rejects with the execFile error (gh's stderr riding on it) on non-zero exit", async () => {
    execFail(
      Object.assign(new Error("Command failed: gh pr view"), {
        stderr: "no pull requests found",
        code: 1,
      }),
    );
    await expect(runGh(["pr", "view"])).rejects.toMatchObject({
      message: "Command failed: gh pr view",
      stderr: "no pull requests found",
    });
  });
});

describe("ghJson", () => {
  it("parses stdout as JSON and returns the typed value", async () => {
    execOk('{"number":7,"state":"OPEN"}');
    const pr = await ghJson<{ number: number; state: string }>([
      "pr",
      "view",
      "--json",
      "number,state",
    ]);
    expect(pr).toEqual({ number: 7, state: "OPEN" });
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      "pr",
      "view",
      "--json",
      "number,state",
    ]);
  });

  it("forwards RunGhOptions to the underlying runGh call", async () => {
    execOk("[]");
    await ghJson(["api", "repos"], { cwd: "/work", maxBuffer: 42 });
    const [, , options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; maxBuffer: number },
    ];
    expect(options.cwd).toBe("/work");
    expect(options.maxBuffer).toBe(42);
  });

  it("rejects with a parse error when gh emits non-JSON (the color-corruption failure class)", async () => {
    execOk("[1mnot json[0m");
    await expect(ghJson(["api", "x"])).rejects.toThrow(SyntaxError);
  });

  it("propagates a gh failure instead of attempting to parse", async () => {
    execFail(new Error("gh: network unreachable"));
    await expect(ghJson(["api", "x"])).rejects.toThrow("network unreachable");
  });
});
