/**
 * Busy-submit triage — proves the deterministic fallback never surprises, the
 * LLM path classifies through the injected port, and EVERY failure mode
 * (timeout, rejection, off-schema output) degrades to a safe "queue" without
 * throwing. The model is a stub, so no gateway is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRIAGE_TIMEOUT_MS,
  TRIAGE_UNAVAILABLE_REASON,
  fallbackTriage,
  triagePrompt,
  type TriageAi,
  type TriageDecision,
} from "../triage.js";
import { modelForTier } from "../../agent/model-router.js";

// The cheap-tier slug the router resolves to must be stable across the suite —
// clear any shell/pinned override so `modelForTier("fast")` uses the catalog.
beforeEach(() => {
  for (const key of ["OXAGEN_LLM_FAST", "OXAGEN_MODEL"])
    delete process.env[key];
});
afterEach(() => vi.restoreAllMocks());

type ObjArgs = { model: string; abortSignal?: AbortSignal; prompt?: string };

/** A TriageAi stub whose generateObject is driven by `impl`, recording every call. */
function stubAi(
  impl: (args: ObjArgs) => Promise<{ object: unknown; usage: unknown }>,
): TriageAi & { calls: ObjArgs[] } {
  const calls: ObjArgs[] = [];
  return {
    calls,
    generateObject: (async (args: ObjArgs) => {
      calls.push(args);
      return impl(args);
    }) as TriageAi["generateObject"],
  };
}

function ok(object: unknown): TriageAi & { calls: ObjArgs[] } {
  return stubAi(async () => ({ object, usage: {} }));
}

const base = { activeSummary: "editing src/auth.ts", queueDepth: 0 };

describe("fallbackTriage — deterministic, never surprises", () => {
  const table: Array<[string, TriageDecision["route"]]> = [
    ["deploy the thing &", "background"], // explicit trailing " &"
    ["  build it &", "background"], // leading whitespace, still background
    ["/model haiku", "queue"], // slash command never backgrounds
    ["!ls -la", "queue"], // shell command never backgrounds
    ["also add a test for that", "queue"], // follow-up
    ["refactor the entire billing package end to end", "queue"], // task-shaped, still queue
    ["yes", "queue"], // short follow-up
    ["&", "queue"], // bare "&" is not a dispatch — reaches the model as text
    ["/deploy &", "queue"], // slash wins over "&": commands never background
    ["", "queue"], // empty
  ];
  it.each(table)("routes %j → %s", (text, route) => {
    expect(fallbackTriage(text).route).toBe(route);
  });

  it("only ever returns background for an explicit ` &`", () => {
    // Any prose without a trailing " &" must queue, never background.
    for (const t of ["big independent job", "meanwhile bump the changelog"]) {
      expect(fallbackTriage(t).route).toBe("queue");
    }
  });
});

describe("triagePrompt — deterministic short-circuit (no model call)", () => {
  it("backgrounds an explicit ` &` without touching the port", async () => {
    const ai = ok({ route: "queue", reason: "should not be consulted" });
    const d = await triagePrompt({ ...base, text: "ship it &", ai });
    expect(d.route).toBe("background");
    expect(ai.calls).toHaveLength(0);
  });

  it("queues a slash command without touching the port", async () => {
    const ai = ok({ route: "background", reason: "nope" });
    const d = await triagePrompt({ ...base, text: "/agents", ai });
    expect(d.route).toBe("queue");
    expect(ai.calls).toHaveLength(0);
  });
});

describe("triagePrompt — LLM path", () => {
  it("returns the model's queue decision and reason", async () => {
    const ai = ok({ route: "queue", reason: "follows up the current edit" });
    const d = await triagePrompt({ ...base, text: "now add a test", ai });
    expect(d).toEqual({
      route: "queue",
      reason: "follows up the current edit",
    });
  });

  it("returns background for an independent task", async () => {
    const ai = ok({
      route: "background",
      reason: "unrelated to the active work",
    });
    const d = await triagePrompt({
      ...base,
      text: "bump the changelog too",
      ai,
    });
    expect(d.route).toBe("background");
  });

  it("returns clarify for an ambiguous prompt", async () => {
    const ai = ok({ route: "clarify", reason: "could be either" });
    const d = await triagePrompt({ ...base, text: "the other one", ai });
    expect(d.route).toBe("clarify");
  });

  it("defaults an empty model reason to a route-specific default", async () => {
    const ai = ok({ route: "background", reason: "   " });
    const d = await triagePrompt({
      ...base,
      text: "do the unrelated thing",
      ai,
    });
    expect(d.route).toBe("background");
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it("clips a runaway model reason", async () => {
    const ai = ok({ route: "queue", reason: "x".repeat(500) });
    const d = await triagePrompt({ ...base, text: "keep going", ai });
    expect(d.reason.length).toBeLessThanOrEqual(200);
    expect(d.reason.endsWith("…")).toBe(true);
  });

  it("uses the cheap 'fast' tier model by default", async () => {
    const ai = ok({ route: "queue", reason: "ok" });
    await triagePrompt({ ...base, text: "carry on", ai });
    expect(ai.calls[0]?.model).toBe(modelForTier("fast"));
  });

  it("honours an explicit model override", async () => {
    const ai = ok({ route: "queue", reason: "ok" });
    await triagePrompt({
      ...base,
      text: "carry on",
      ai,
      model: "anthropic/claude-fable",
    });
    expect(ai.calls[0]?.model).toBe("anthropic/claude-fable");
  });

  it("includes the active summary and queue depth in the prompt", async () => {
    const ai = ok({ route: "queue", reason: "ok" });
    await triagePrompt({
      text: "keep going",
      activeSummary: "wiring the billing meter",
      queueDepth: 3,
      ai,
    });
    expect(ai.calls[0]?.prompt).toContain("wiring the billing meter");
    expect(ai.calls[0]?.prompt).toContain("3");
  });
});

describe("triagePrompt — always degrades safely, never throws", () => {
  it("queues on a rejected model call", async () => {
    const ai = stubAi(async () => {
      throw new Error("gateway down");
    });
    const d = await triagePrompt({ ...base, text: "do a new thing", ai });
    expect(d).toEqual({ route: "queue", reason: TRIAGE_UNAVAILABLE_REASON });
  });

  it("queues on off-schema model output", async () => {
    const ai = ok({ route: "teleport", reason: 42 });
    const d = await triagePrompt({ ...base, text: "do a new thing", ai });
    expect(d).toEqual({ route: "queue", reason: TRIAGE_UNAVAILABLE_REASON });
  });

  it("queues and aborts the in-flight call on timeout", async () => {
    let captured: AbortSignal | undefined;
    const ai = stubAi((args) => {
      captured = args.abortSignal;
      return new Promise(() => {}); // never resolves
    });
    const d = await triagePrompt({
      ...base,
      text: "long running classify",
      ai,
      timeoutMs: 10,
    });
    expect(d).toEqual({ route: "queue", reason: TRIAGE_UNAVAILABLE_REASON });
    expect(captured?.aborted).toBe(true);
  });

  it("bypasses the timeout bound when timeoutMs <= 0", async () => {
    const ai = ok({ route: "background", reason: "unbounded ok" });
    const d = await triagePrompt({
      ...base,
      text: "an unrelated job",
      ai,
      timeoutMs: 0,
    });
    expect(d.route).toBe("background");
  });

  it("exposes a sane default timeout", () => {
    expect(DEFAULT_TRIAGE_TIMEOUT_MS).toBe(3_000);
  });
});
