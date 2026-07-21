/**
 * `oxagen logs` — proves the debug-log surface: --path prints the file location,
 * --clear empties it, the default view tails recent entries, --category filters,
 * --json emits raw JSONL, and the "debug is off" hint goes to stderr without
 * throwing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "oxa-logscmd-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

import { handleLogs } from "../logs.js";
import {
  debugLog,
  clearDebugLog,
  debugLogFile,
  DEBUG_ENV,
} from "../../lib/debug-log.js";

let out = "";
let err = "";
let outWrite: typeof process.stdout.write;
let errWrite: typeof process.stderr.write;

beforeEach(() => {
  out = "";
  err = "";
  outWrite = process.stdout.write.bind(process.stdout);
  errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  process.env[DEBUG_ENV] = "1";
});

afterEach(async () => {
  process.env[DEBUG_ENV] = "1";
  await clearDebugLog();
  delete process.env[DEBUG_ENV];
  process.stdout.write = outWrite;
  process.stderr.write = errWrite;
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("oxagen logs", () => {
  it("--path prints the log file location", async () => {
    await handleLogs({ path: true });
    expect(out.trim()).toBe(debugLogFile());
  });

  it("--clear truncates the log", async () => {
    await debugLog("turn", "will-be-cleared");
    await handleLogs({ clear: true });
    expect(out).toContain("Cleared");
    await handleLogs({ json: true });
    expect(out).not.toContain("will-be-cleared");
  });

  it("tails recent entries in the default formatted view", async () => {
    await debugLog("invoke", "cli.start", { argv: ["logs"] });
    await debugLog("code-graph", "query", { operation: "neighbors" });
    await handleLogs({});
    expect(out).toContain("cli.start");
    expect(out).toContain("code-graph");
    expect(out).toContain("query");
  });

  it("--category filters to one category", async () => {
    await debugLog("llm", "llm.stream.request", { model: "m" });
    await debugLog("code-graph", "query", { operation: "neighbors" });
    await handleLogs({ category: "code-graph" });
    expect(out).toContain("query");
    expect(out).not.toContain("llm.stream.request");
  });

  it("--json emits raw JSONL that parses back", async () => {
    await debugLog("turn", "turn.start", { mode: "one-shot" });
    await handleLogs({ json: true });
    const lines = out.trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as { event: string });
    expect(parsed.some((p) => p.event === "turn.start")).toBe(true);
  });

  it("warns to stderr when debug logging is off", async () => {
    delete process.env[DEBUG_ENV];
    await handleLogs({});
    expect(err).toContain(DEBUG_ENV);
    expect(err).toContain(debugLogFile());
  });
});
