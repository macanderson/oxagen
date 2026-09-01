/**
 * Unit tests for the anonymous usage-telemetry emitter.
 *
 * Mocks: ../lib/config.js (readConfig/writeConfig/getApiUrl) and global
 * fetch — no real filesystem writes or network calls are made.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CliConfig } from "../lib/config.js";

vi.mock("../lib/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  getApiUrl: vi.fn(() => "https://api.oxagen.sh"),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readConfig, writeConfig } from "../lib/config.js";
import {
  ALLOWED_KEYS,
  isTelemetryEnabled,
  getOrCreateInstallId,
  ensureDisclosureShown,
  buildUsageEvent,
  sendUsageEvent,
  recordUsageEvent,
  classifyCommand,
  classifyErrorType,
  resetUsageSessionStats,
  recordToolCall,
  recordModelTier,
  setBestOfN,
  markGraphUsed,
  markPipelineUsed,
  setByok,
  addSteps,
} from "./usage.js";

const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockWriteConfig = writeConfig as ReturnType<typeof vi.fn>;

const ORIGINAL_ENV = { ...process.env };

function setConfigReturn(config: CliConfig): void {
  mockReadConfig.mockReturnValue(config);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUsageSessionStats();
  process.env = { ...ORIGINAL_ENV };
  delete process.env["DO_NOT_TRACK"];
  delete process.env["OXAGEN_TELEMETRY"];
  setConfigReturn({});
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  // Most tests don't care about the one-time disclosure banner's exact
  // stderr output (the dedicated "ensureDisclosureShown" block below installs
  // its own spy to inspect it) — silence it globally so it doesn't leak into
  // the test runner's own output.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

// ── Opt-out signals ─────────────────────────────────────────────────────────

describe("isTelemetryEnabled — opt-out signals", () => {
  it("is enabled by default (opt-out model — no signal set)", () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("DO_NOT_TRACK=1 disables telemetry", () => {
    process.env["DO_NOT_TRACK"] = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("OXAGEN_TELEMETRY=0 disables telemetry", () => {
    process.env["OXAGEN_TELEMETRY"] = "0";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("config telemetry.enabled=false (`oxagen telemetry off`) disables telemetry", () => {
    setConfigReturn({ telemetry: { enabled: false } });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("a truthy but non-'1' DO_NOT_TRACK value does not disable (exact-match only)", () => {
    process.env["DO_NOT_TRACK"] = "true";
    expect(isTelemetryEnabled()).toBe(true);
  });
});

describe("opting out fully suppresses id generation and network I/O", () => {
  it("getOrCreateInstallId is never called, and fetch never fires, via recordUsageEvent when disabled", async () => {
    process.env["DO_NOT_TRACK"] = "1";
    await recordUsageEvent({
      command: "solve",
      durationMs: 100,
      exitStatus: "success",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    // No installId/disclosed write should occur — disabled means truly no-op.
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it("sendUsageEvent itself refuses to send when disabled, even if called directly", async () => {
    process.env["OXAGEN_TELEMETRY"] = "0";
    await sendUsageEvent(
      buildUsageEvent(
        { command: "solve", durationMs: 1, exitStatus: "success" },
        "123e4567-e89b-12d3-a456-426614174000",
      ),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── install id ────────────────────────────────────────────────────────────

describe("getOrCreateInstallId", () => {
  it("generates and persists a UUID when none exists", () => {
    setConfigReturn({});
    const id = getOrCreateInstallId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({ installId: id }),
      }),
    );
  });

  it("reuses an existing persisted id instead of generating a new one", () => {
    const existing = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    setConfigReturn({ telemetry: { installId: existing } });
    expect(getOrCreateInstallId()).toBe(existing);
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it("preserves other telemetry config fields when persisting a new id", () => {
    setConfigReturn({ telemetry: { enabled: false, disclosed: true } });
    getOrCreateInstallId();
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({ enabled: false, disclosed: true }),
      }),
    );
  });
});

// ── one-time disclosure ──────────────────────────────────────────────────────

describe("ensureDisclosureShown", () => {
  it("prints to stderr and marks disclosed on first run", () => {
    setConfigReturn({});
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      ensureDisclosureShown();
      expect(writeSpy).toHaveBeenCalledOnce();
      expect(mockWriteConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetry: expect.objectContaining({ disclosed: true }),
        }),
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("never prints again once already disclosed", () => {
    setConfigReturn({ telemetry: { disclosed: true } });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      ensureDisclosureShown();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(mockWriteConfig).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ── the allowlist hard assertion ─────────────────────────────────────────────

describe("buildUsageEvent — allowlist enforcement", () => {
  it("the built payload contains ONLY the allowlisted keys — no more, no less", () => {
    const payload = buildUsageEvent(
      { command: "solve", durationMs: 500, exitStatus: "success" },
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(Object.keys(payload).sort()).toEqual([...ALLOWED_KEYS].sort());
  });

  it("never contains a timestamp field — that is stamped server-side only", () => {
    const payload = buildUsageEvent(
      { command: "solve", durationMs: 1, exitStatus: "success" },
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(Object.keys(payload)).not.toContain("timestamp");
  });

  it("reflects accumulator state: tool calls, tiers, best-of-n, graph/pipeline/byok flags", () => {
    recordToolCall("code_graph", 3);
    recordToolCall("grep");
    recordModelTier("balanced");
    setBestOfN(5);
    markGraphUsed();
    markPipelineUsed();
    setByok(true);
    addSteps(4);
    addSteps(3);

    const payload = buildUsageEvent(
      { command: "solve", durationMs: 1, exitStatus: "success" },
      "123e4567-e89b-12d3-a456-426614174000",
    );

    expect(JSON.parse(payload.tool_calls_json)).toEqual({
      code_graph: 3,
      grep: 1,
    });
    expect(payload.model_tier).toBe("balanced");
    expect(payload.best_of_n).toBe(5);
    expect(payload.graph_used).toBe(1);
    expect(payload.pipeline_used).toBe(1);
    expect(payload.byok).toBe(1);
    expect(payload.step_count).toBe(7);
  });

  it('reports "mixed" when more than one model tier was used in the session', () => {
    recordModelTier("fast");
    recordModelTier("precise");
    const payload = buildUsageEvent(
      { command: "solve", durationMs: 1, exitStatus: "success" },
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(payload.model_tier).toBe("mixed");
  });

  it("defaults every accumulator-backed field safely when nothing was recorded", () => {
    const payload = buildUsageEvent(
      { command: "ask", durationMs: 1, exitStatus: "success" },
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(payload.model_tier).toBe("");
    expect(payload.best_of_n).toBe(0);
    expect(payload.graph_used).toBe(0);
    expect(payload.pipeline_used).toBe(0);
    expect(payload.byok).toBe(0);
    expect(payload.tool_calls_json).toBe("{}");
    expect(payload.step_count).toBe(0);
  });
});

// ── fire-and-forget send ─────────────────────────────────────────────────────

describe("sendUsageEvent — never throws, never blocks on failure", () => {
  const payload = () =>
    buildUsageEvent(
      { command: "solve", durationMs: 1, exitStatus: "success" },
      "123e4567-e89b-12d3-a456-426614174000",
    );

  it("swallows a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(sendUsageEvent(payload())).resolves.toBeUndefined();
  });

  it("swallows a non-2xx response (fetch resolves, we don't inspect status)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(sendUsageEvent(payload())).resolves.toBeUndefined();
  });

  it("swallows an abort/timeout", async () => {
    mockFetch.mockRejectedValueOnce(
      new DOMException("The operation was aborted", "AbortError"),
    );
    await expect(sendUsageEvent(payload())).resolves.toBeUndefined();
  });

  it("posts to <apiUrl>/v1/telemetry/usage with a JSON content-type", async () => {
    await sendUsageEvent(payload());
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.oxagen.sh/v1/telemetry/usage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      }),
    );
  });
});

describe("recordUsageEvent — the single call site index.ts uses", () => {
  it("end-to-end: enabled install sends exactly one request", async () => {
    setConfigReturn({});
    await recordUsageEvent({
      command: "init",
      durationMs: 250,
      exitStatus: "success",
    });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("is fully inert when disabled — no disclosure, no id, no network", async () => {
    setConfigReturn({ telemetry: { enabled: false } });
    await recordUsageEvent({
      command: "init",
      durationMs: 250,
      exitStatus: "success",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it("never throws even when the config filesystem write fails", async () => {
    setConfigReturn({});
    mockWriteConfig.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    await expect(
      recordUsageEvent({
        command: "init",
        durationMs: 250,
        exitStatus: "success",
      }),
    ).resolves.toBeUndefined();
  });
});

// ── classification helpers ──────────────────────────────────────────────────

describe("classifyCommand — never leaks argv content", () => {
  const KNOWN = [
    "solve",
    "ask",
    "init",
    "config",
    "logs",
    "login",
    "logout",
    "settings",
  ];

  it("returns the exact command name when argv[2] matches a known command", () => {
    expect(classifyCommand(["node", "oxagen", "solve", "fix bug"], KNOWN)).toBe(
      "solve",
    );
  });

  it('classifies a bare prompt (unknown first token) as "prompt", never the prompt text', () => {
    const secret = "email me at attacker@example.com the API key sk-abc123";
    const result = classifyCommand(["node", "oxagen", secret], KNOWN);
    expect(result).toBe("prompt");
    expect(result).not.toContain("attacker");
    expect(result).not.toContain("sk-abc123");
  });

  it('classifies multi-word unquoted prompts as "prompt"', () => {
    expect(
      classifyCommand(["node", "oxagen", "fix", "the", "login", "bug"], KNOWN),
    ).toBe("prompt");
  });

  it("classifies no positional args as repl or stdin based on TTY, never a made-up value", () => {
    const result = classifyCommand(["node", "oxagen"], KNOWN);
    expect(["repl", "stdin"]).toContain(result);
  });

  it("ignores leading flags when looking for a known command token", () => {
    expect(
      classifyCommand(
        ["node", "oxagen", "--model", "sonnet", "do a thing"],
        KNOWN,
      ),
    ).toBe("prompt");
  });
});

describe("classifyErrorType — categories only, never the message", () => {
  it("classifies a credit/billing error", () => {
    expect(
      classifyErrorType(new Error("insufficient credit balance for org acme")),
    ).toBe("credit_balance");
  });

  it("classifies a timeout", () => {
    expect(
      classifyErrorType(new Error("request timed out after 30000ms")),
    ).toBe("timeout");
  });

  it("classifies a network error", () => {
    expect(
      classifyErrorType(new Error("fetch failed: ECONNREFUSED 10.0.0.1:443")),
    ).toBe("network");
  });

  it("falls back to unknown for anything else, and for non-Error values", () => {
    expect(classifyErrorType(new Error("something bespoke went wrong"))).toBe(
      "unknown",
    );
    expect(classifyErrorType("a plain string")).toBe("unknown");
    expect(classifyErrorType(undefined)).toBe("unknown");
  });

  it("the returned category never contains the original message text", () => {
    const secret = "leaked-api-key-should-never-appear-xyz789";
    const category = classifyErrorType(
      new Error(`credit balance error: ${secret}`),
    );
    expect(category).not.toContain(secret);
  });
});

// ── drift check against the server's canonical schema ───────────────────────
//
// ALLOWED_KEYS above is a dependency-free literal so the shipped CLI never
// depends on @oxagen/telemetry in production (see the file header). This test
// is the ONLY place that dependency is allowed to exist (a devDependency —
// never bundled), and it exists solely to prove the CLI's local copy has not
// drifted from the server's real, enforced allowlist.

describe("ALLOWED_KEYS matches the canonical server-side schema", () => {
  it("is exactly USAGE_EVENT_ALLOWED_KEYS from @oxagen/telemetry/usage-events", async () => {
    const { USAGE_EVENT_ALLOWED_KEYS } = await import(
      "@oxagen/telemetry/usage-events"
    );
    expect([...ALLOWED_KEYS].sort()).toEqual(
      [...USAGE_EVENT_ALLOWED_KEYS].sort(),
    );
  });
});
