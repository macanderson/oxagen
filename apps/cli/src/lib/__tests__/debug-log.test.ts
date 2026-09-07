/**
 * Debug log (`OXAGEN_CLI_DEBUG`) — proves the `.output` stream: it is a no-op
 * when the flag is off, appends JSONL under ~/.oxagen/logs when on, redacts
 * secrets, caps oversized strings, reads back the tail (skipping corrupt lines),
 * and clears cleanly.
 */
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, it, expect, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "oxa-dlog-"));

// Point homedir() at a throwaway dir so the log lands somewhere disposable.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

import {
  debugLog,
  readDebugLog,
  clearDebugLog,
  debugLogFile,
  logsDir,
  isDebugEnabled,
  DEBUG_ENV,
} from "../debug-log.js";

function enable(): void {
  process.env[DEBUG_ENV] = "1";
}
function disable(): void {
  delete process.env[DEBUG_ENV];
}

afterEach(() => {
  // Remove the file directly (clearDebugLog would *create* an empty one, which
  // would defeat the "no-op when disabled" assertion in the next test).
  rmSync(debugLogFile(), { force: true });
  disable();
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("debug log paths", () => {
  it("resolves under ~/.oxagen/logs/cli.output", () => {
    expect(logsDir()).toBe(join(HOME, ".oxagen", "logs"));
    expect(debugLogFile()).toBe(join(HOME, ".oxagen", "logs", "cli.output"));
  });
});

describe("gating on OXAGEN_CLI_DEBUG", () => {
  it("is a no-op and writes nothing when the flag is off", async () => {
    rmSync(debugLogFile(), { force: true });
    disable();
    expect(isDebugEnabled()).toBe(false);
    await debugLog("invoke", "cli.start", { argv: ["x"] });
    expect(existsSync(debugLogFile())).toBe(false);
  });

  it('is enabled for "1" and "true"', () => {
    process.env[DEBUG_ENV] = "1";
    expect(isDebugEnabled()).toBe(true);
    process.env[DEBUG_ENV] = "true";
    expect(isDebugEnabled()).toBe(true);
    process.env[DEBUG_ENV] = "0";
    expect(isDebugEnabled()).toBe(false);
  });
});

describe("appending entries", () => {
  it("appends each call as one JSONL entry and reads it back", async () => {
    enable();
    await debugLog("invoke", "cli.start", { argv: ["logs"] });
    await debugLog("code-graph", "query", { operation: "neighbors" });
    const entries = await readDebugLog();
    expect(entries.map((e) => e.event)).toEqual(["cli.start", "query"]);
    expect(entries[0]?.category).toBe("invoke");
    expect(entries[1]?.category).toBe("code-graph");
    expect(entries[0]?.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("redacts secret-bearing keys anywhere in the payload", async () => {
    enable();
    await debugLog("api", "api.post.request", {
      token: "sk-secret",
      body: {
        Authorization: "Bearer abc",
        nested: { password: "p" },
        keep: "visible",
      },
    });
    const [entry] = await readDebugLog();
    const data = entry?.data as Record<string, unknown>;
    expect(data["token"]).toBe("[redacted]");
    const body = data["body"] as Record<string, unknown>;
    expect(body["Authorization"]).toBe("[redacted]");
    expect((body["nested"] as Record<string, unknown>)["password"]).toBe(
      "[redacted]",
    );
    expect(body["keep"]).toBe("visible");
  });

  it("caps an oversized string so one payload can't blow up a line", async () => {
    enable();
    await debugLog("llm", "llm.stream.request", { blob: "x".repeat(100_000) });
    const [entry] = await readDebugLog();
    const data = entry?.data as Record<string, unknown>;
    expect(String(data["blob"])).toContain("…[+");
    expect(String(data["blob"]).length).toBeLessThan(60_000);
  });
});

describe("reading", () => {
  it("returns only the last `limit` entries", async () => {
    enable();
    for (let i = 0; i < 10; i++) await debugLog("turn", `e${i}`);
    const last3 = await readDebugLog(3);
    expect(last3.map((e) => e.event)).toEqual(["e7", "e8", "e9"]);
  });

  it("skips a corrupt line instead of failing the whole read", async () => {
    enable();
    await debugLog("turn", "good-1");
    appendFileSync(debugLogFile(), "{not json\n", "utf8");
    await debugLog("turn", "good-2");
    const events = (await readDebugLog()).map((e) => e.event);
    expect(events).toContain("good-1");
    expect(events).toContain("good-2");
  });

  it("returns [] when the log does not exist", async () => {
    disable();
    enable();
    await clearDebugLog();
    rmSync(debugLogFile(), { force: true });
    expect(await readDebugLog()).toEqual([]);
  });
});

describe("clearing", () => {
  it("truncates the log to empty", async () => {
    enable();
    await debugLog("turn", "before-clear");
    await clearDebugLog();
    expect(await readDebugLog()).toEqual([]);
  });
});

describe("sanitizing exotic payloads", () => {
  it("unwraps an Error into name/message/stack rather than an empty object", async () => {
    enable();
    const err = new TypeError("kaboom");
    await debugLog("api", "request.failed", { err });
    const [entry] = await readDebugLog(1);
    const data = entry!.data as { err: Record<string, unknown> };
    expect(data.err.name).toBe("TypeError");
    expect(data.err.message).toBe("kaboom");
    expect(typeof data.err.stack).toBe("string");
  });

  it("stringifies values JSON has no representation for", async () => {
    enable();
    await debugLog("api", "odd.payload", {
      fn: () => 1,
      big: BigInt(9),
      sym: Symbol("s"),
    });
    const [entry] = await readDebugLog(1);
    const data = entry!.data as Record<string, string>;
    expect(data.fn).toContain("=>");
    expect(data.big).toBe("9");
    expect(data.sym).toBe("Symbol(s)");
  });
});

describe("failure handling — never propagates, reports under OXAGEN_DEBUG", () => {
  /** Make the log PATH a directory so appendFile/writeFile fail at the OS level. */
  function blockLogFile(): void {
    rmSync(debugLogFile(), { force: true });
    mkdirSync(debugLogFile(), { recursive: true });
  }
  function unblockLogFile(): void {
    rmSync(debugLogFile(), { recursive: true, force: true });
  }

  it("swallows an append failure and reports it on stderr under OXAGEN_DEBUG", async () => {
    enable();
    blockLogFile();
    process.env["OXAGEN_DEBUG"] = "1";
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      written.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(debugLog("api", "will.fail")).resolves.toBeUndefined();
    } finally {
      process.stderr.write = original;
      delete process.env["OXAGEN_DEBUG"];
      unblockLogFile();
    }
    expect(written.join("")).toContain("[debug-log] append failed");
  });

  it("swallows a clear failure and reports it on stderr under OXAGEN_DEBUG", async () => {
    blockLogFile();
    process.env["OXAGEN_DEBUG"] = "1";
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      written.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(clearDebugLog()).resolves.toBeUndefined();
    } finally {
      process.stderr.write = original;
      delete process.env["OXAGEN_DEBUG"];
      unblockLogFile();
    }
    expect(written.join("")).toContain("[debug-log] clear failed");
  });
});
