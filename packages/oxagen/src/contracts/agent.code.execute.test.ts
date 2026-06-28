import { describe, expect, it } from "vitest";
import { agentCodeExecute } from "./agent.code.execute";
import { getCapability } from "../registry";

describe("agent.code.execute capability", () => {
  // ── input: language enum ──────────────────────────────────────────────────

  it("accepts language='node'", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "console.log(1)" });
    expect(parsed.language).toBe("node");
  });

  it("accepts language='python'", () => {
    const parsed = agentCodeExecute.input.parse({ language: "python", code: "print(1)" });
    expect(parsed.language).toBe("python");
  });

  it("accepts language='shell'", () => {
    const parsed = agentCodeExecute.input.parse({ language: "shell", code: "echo hi" });
    expect(parsed.language).toBe("shell");
  });

  it("rejects an unknown language", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "ruby", code: "puts 1" }),
    ).toThrow();
  });

  // ── input: code field ─────────────────────────────────────────────────────

  it("rejects empty code string (min 1)", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "" }),
    ).toThrow();
  });

  it("accepts a non-empty code string", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x" });
    expect(parsed.code).toBe("x");
  });

  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults timeoutMs to 30000", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x" });
    expect(parsed.timeoutMs).toBe(30_000);
  });

  it("defaults memoryMb to 256", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x" });
    expect(parsed.memoryMb).toBe(256);
  });

  it("defaults network to 'deny'", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x" });
    expect(parsed.network).toBe("deny");
  });

  // ── input: timeoutMs bounds ───────────────────────────────────────────────

  it("accepts timeoutMs=1000 (min)", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x", timeoutMs: 1000 });
    expect(parsed.timeoutMs).toBe(1000);
  });

  it("accepts timeoutMs=300000 (max)", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x", timeoutMs: 300_000 });
    expect(parsed.timeoutMs).toBe(300_000);
  });

  it("rejects timeoutMs=999 (below min)", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "x", timeoutMs: 999 }),
    ).toThrow();
  });

  it("rejects timeoutMs=300001 (above max)", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "x", timeoutMs: 300_001 }),
    ).toThrow();
  });

  it("rejects a non-integer timeoutMs", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "x", timeoutMs: 1000.5 }),
    ).toThrow();
  });

  // ── input: memoryMb bounds ────────────────────────────────────────────────

  it("accepts memoryMb=64 (min)", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x", memoryMb: 64 });
    expect(parsed.memoryMb).toBe(64);
  });

  it("accepts memoryMb=2048 (max)", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x", memoryMb: 2048 });
    expect(parsed.memoryMb).toBe(2048);
  });

  it("rejects memoryMb=63 (below min)", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "x", memoryMb: 63 }),
    ).toThrow();
  });

  it("rejects memoryMb=2049 (above max)", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "x", memoryMb: 2049 }),
    ).toThrow();
  });

  // ── input: network enum ───────────────────────────────────────────────────

  it("accepts network='allow'", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x", network: "allow" });
    expect(parsed.network).toBe("allow");
  });

  it("rejects an unknown network value", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "x", network: "blocked" }),
    ).toThrow();
  });

  // ── input: optional fields ────────────────────────────────────────────────

  it("accepts optional stdin", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x", stdin: "hello" });
    expect(parsed.stdin).toBe("hello");
  });

  it("accepts optional env record", () => {
    const parsed = agentCodeExecute.input.parse({
      language: "node",
      code: "x",
      env: { FOO: "bar" },
    });
    expect(parsed.env).toEqual({ FOO: "bar" });
  });

  // ── input: env trust boundary (sanitizeSandboxEnv) ────────────────────────

  it("strips reserved env keys and prefixes, keeps safe ones", () => {
    const parsed = agentCodeExecute.input.parse({
      language: "node",
      code: "x",
      env: {
        SAFE: "ok",
        PATH: "/evil",
        LD_PRELOAD: "/x.so",
        MODAL_TOKEN: "secret",
        DATABASE_URL: "postgres://...",
      },
    });
    expect(parsed.env).toEqual({ SAFE: "ok" });
  });

  it("drops env keys that are not POSIX-shaped names", () => {
    const parsed = agentCodeExecute.input.parse({
      language: "node",
      code: "x",
      env: { "bad-key": "v", "1leading": "v", GOOD_KEY: "v" },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "v" });
  });

  it("collapses an all-unsafe env to undefined", () => {
    const parsed = agentCodeExecute.input.parse({
      language: "node",
      code: "x",
      env: { PATH: "/x", "bad key": "v" },
    });
    expect(parsed.env).toBeUndefined();
  });

  it("caps the env at 32 keys", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 40; i++) env[`K${i}`] = "v";
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x", env });
    expect(Object.keys(parsed.env ?? {})).toHaveLength(32);
  });

  // ── input: workspace files map ────────────────────────────────────────────

  it("accepts a valid files map", () => {
    const parsed = agentCodeExecute.input.parse({
      language: "node",
      code: "require('./util')",
      files: { "util.js": "module.exports = 1", "lib/a.js": "1" },
    });
    expect(parsed.files).toEqual({ "util.js": "module.exports = 1", "lib/a.js": "1" });
  });

  it("treats files as optional", () => {
    const parsed = agentCodeExecute.input.parse({ language: "node", code: "x" });
    expect(parsed.files).toBeUndefined();
  });

  it("rejects a files map with a path-traversal key", () => {
    expect(() =>
      agentCodeExecute.input.parse({
        language: "node",
        code: "x",
        files: { "../escape.js": "evil" },
      }),
    ).toThrow();
  });

  it("rejects a files map with an absolute path key", () => {
    expect(() =>
      agentCodeExecute.input.parse({
        language: "node",
        code: "x",
        files: { "/etc/passwd": "evil" },
      }),
    ).toThrow();
  });

  it("rejects a files map that exceeds the file-count cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= 64; i++) files[`f${i}.js`] = "x";
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "x", files }),
    ).toThrow();
  });

  // ── input: required fields ────────────────────────────────────────────────

  it("rejects input missing language", () => {
    expect(() => agentCodeExecute.input.parse({ code: "x" })).toThrow();
  });

  it("rejects input missing code", () => {
    expect(() => agentCodeExecute.input.parse({ language: "node" })).toThrow();
  });

  it("rejects wrong type for code", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: 42 }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid successful output", () => {
    const parsed = agentCodeExecute.output.parse({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      executionMs: 123,
      timedOut: false,
      oomKilled: false,
    });
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("hello\n");
    expect(parsed.stderr).toBe("");
    expect(parsed.executionMs).toBe(123);
    expect(parsed.timedOut).toBe(false);
    expect(parsed.oomKilled).toBe(false);
  });

  it("parses a timed-out output", () => {
    const parsed = agentCodeExecute.output.parse({
      exitCode: 124,
      stdout: "",
      stderr: "Timeout",
      executionMs: 30_000,
      timedOut: true,
      oomKilled: false,
    });
    expect(parsed.timedOut).toBe(true);
    expect(parsed.oomKilled).toBe(false);
  });

  it("parses an OOM-killed output", () => {
    const parsed = agentCodeExecute.output.parse({
      exitCode: 137,
      stdout: "",
      stderr: "",
      executionMs: 5000,
      timedOut: false,
      oomKilled: true,
    });
    expect(parsed.oomKilled).toBe(true);
  });

  it("rejects output missing stdout", () => {
    expect(() =>
      agentCodeExecute.output.parse({
        exitCode: 0,
        stderr: "",
        executionMs: 10,
        timedOut: false,
        oomKilled: false,
      }),
    ).toThrow();
  });

  it("rejects output with non-boolean timedOut", () => {
    expect(() =>
      agentCodeExecute.output.parse({
        exitCode: 0,
        stdout: "",
        stderr: "",
        executionMs: 10,
        timedOut: "yes",
        oomKilled: false,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.code.execute")).toBe(agentCodeExecute);
  });
});
