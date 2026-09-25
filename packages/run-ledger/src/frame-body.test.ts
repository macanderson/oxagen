import { describe, expect, it } from "vitest";
import {
  deriveCompletenessGaps,
  deriveSealRollup,
  gradeSealedAttempt,
  ledgerEnforcementTier,
  type RetentionPolicyBinding,
  type SealedFrameRow,
} from "./frame-body";

const FULL: RetentionPolicyBinding = {
  mode: "full",
  retainedContentClasses: ["model_call", "tool_call"],
};
const DIGEST_ONLY: RetentionPolicyBinding = {
  mode: "digest_only",
  retainedContentClasses: [],
};

let seq = 0;
function row(
  event_type: string,
  over: Partial<SealedFrameRow> = {},
): SealedFrameRow {
  seq += 1;
  return {
    id: `e${seq}`,
    attempt_seq: seq,
    run_seq: seq,
    event_schema_version: "1",
    event_type,
    stage: "act",
    payload_digest: `sha256:${"a".repeat(64)}`,
    event_digest: `sha256:${String(seq).padStart(64, "0")}`,
    payload_inline: null,
    encrypted_payload_ref: null,
    observed_at: "2026-09-11T10:00:00.000Z",
    created_at: "2026-09-11T10:00:00.000Z",
    body_ref: null,
    body_digest: null,
    body_bytes: null,
    redactions: null,
    fidelity: "digest_only",
    ...over,
  };
}

/** A frame whose bytes the store retained. */
const kept = (event_type: string, over: Partial<SealedFrameRow> = {}) =>
  row(event_type, {
    body_ref: "evb:v1:k:abc",
    body_digest: `sha256:${"b".repeat(64)}`,
    fidelity: "full",
    ...over,
  });

describe("deriveSealRollup", () => {
  it("counts the engine's own completed calls, which it used to skip entirely", () => {
    const rollup = deriveSealRollup([
      row("model.engine_call_completed"),
      row("tool.engine_call_completed"),
      row("tool.engine_call_completed"),
    ]);
    expect(rollup.modelCalls).toBe(1);
    expect(rollup.toolCalls).toBe(2);
  });

  it("does not count a write-ahead intention as a call that happened", () => {
    const rollup = deriveSealRollup([
      row("model.engine_call_started"),
      row("tool.engine_call_started"),
    ]);
    expect(rollup).toMatchObject({ modelCalls: 0, toolCalls: 0 });
  });

  it("counts distinct turn indexes, and reports null when a model call hides one", () => {
    expect(
      deriveSealRollup([
        row("model.call_completed", { payload_inline: { turn_index: 1 } }),
        row("model.call_completed", { payload_inline: { turn_index: 1 } }),
        row("model.call_completed", { payload_inline: { turn_index: 2 } }),
      ]).turns,
    ).toBe(2);
    // An engine call's schema carries no turn index, so the count is not
    // recorded rather than reported as the calls that happened to be legible.
    expect(
      deriveSealRollup([
        row("model.call_completed", { payload_inline: { turn_index: 1 } }),
        row("model.engine_call_completed"),
      ]).turns,
    ).toBeNull();
  });
});

describe("deriveCompletenessGaps", () => {
  it("names digest_only when the pinned policy kept digests alone", () => {
    expect(
      deriveCompletenessGaps({
        rows: [row("model.call_completed")],
        policy: DIGEST_ONLY,
        terminalStatus: "completed",
      }),
    ).toContain("digest_only");
  });

  it("names body_missing for an engine call that kept no body", () => {
    expect(
      deriveCompletenessGaps({
        rows: [row("tool.engine_call_completed")],
        policy: FULL,
        terminalStatus: "completed",
      }),
    ).toContain("body_missing");
  });

  it("names no body_missing when every engine-call half retained its body", () => {
    // The four engine_call types are content-bearing so a view reader can
    // open both halves of each exchange. Recording bodies on them (subject
    // to retention) is what unlocks view and fork; without bodies, the same
    // set caps every in-app assistant run at inspect.
    const rows = [
      kept("model.engine_call_started"),
      kept("model.engine_call_completed"),
      kept("tool.engine_call_started"),
      kept("tool.engine_call_completed"),
    ];
    const gaps = deriveCompletenessGaps({
      rows,
      policy: FULL,
      terminalStatus: "completed",
    });
    expect(gaps).not.toContain("body_missing");
    expect(gaps).not.toContain("tool_bodies");
    expect(
      gradeSealedAttempt(gaps, rows.length, ledgerEnforcementTier(rows)),
    ).toBe("fork");
  });

  it("names tool_bodies when engine tool calls happened and none kept a result", () => {
    // Before the engine vocabulary reached this derivation, a run whose only
    // tool calls were the engine's sealed with no tool_bodies gap at all.
    const gaps = deriveCompletenessGaps({
      rows: [
        kept("model.engine_call_completed"),
        row("tool.engine_call_completed"),
      ],
      policy: FULL,
      terminalStatus: "completed",
    });
    expect(gaps).toContain("tool_bodies");
  });

  it("names no tool_bodies gap when a tool result was kept", () => {
    expect(
      deriveCompletenessGaps({
        rows: [kept("tool.engine_call_completed")],
        policy: FULL,
        terminalStatus: "completed",
      }),
    ).not.toContain("tool_bodies");
  });

  it("grades inspect when a prompt was dropped for size and its answer was kept", () => {
    // `jsonBody` writes no body past the 1 MiB cap. The write-ahead frame then
    // has no body reference, and a reader cannot see what the model was
    // asked, so the run is not `view` (#3372, finding 1).
    const rows = [
      row("model.engine_call_started"),
      kept("model.engine_call_completed"),
      kept("tool.engine_call_started"),
      kept("tool.engine_call_completed"),
    ];
    const gaps = deriveCompletenessGaps({
      rows,
      policy: FULL,
      terminalStatus: "completed",
    });
    expect(gaps).toEqual(["body_missing"]);
    expect(gradeSealedAttempt(gaps, 3, ledgerEnforcementTier(rows))).toBe(
      "inspect",
    );
  });

  it("names unobserved_tail for an abandoned attempt (negative path)", () => {
    expect(
      deriveCompletenessGaps({
        rows: [kept("tool.call_completed")],
        policy: FULL,
        terminalStatus: "abandoned",
      }),
    ).toContain("unobserved_tail");
  });
});

describe("ledgerEnforcementTier", () => {
  it("is gateway when every model call was the engine's own, observed at the gateway", () => {
    expect(
      ledgerEnforcementTier([
        row("model.engine_call_started"),
        row("model.engine_call_completed"),
        row("tool.engine_call_completed"),
      ]),
    ).toBe("gateway");
  });

  it("is harness when a model call was submitted as evidence", () => {
    expect(ledgerEnforcementTier([row("model.call_completed")])).toBe(
      "harness",
    );
    // A run with both was only partly observed and grades at the weaker tier.
    expect(
      ledgerEnforcementTier([
        row("model.engine_call_completed"),
        row("model.call_completed"),
      ]),
    ).toBe("harness");
  });

  it("is harness for a run with no model call: an absence is not observation", () => {
    expect(ledgerEnforcementTier([])).toBe("harness");
    expect(ledgerEnforcementTier([row("admission.run_admitted")])).toBe(
      "harness",
    );
  });
});

describe("gradeSealedAttempt", () => {
  it("reaches fork on a gateway-observed recording with a complete cassette", () => {
    expect(gradeSealedAttempt([], 4, "gateway")).toBe("fork");
  });

  it("caps a submitted recording at view, which is what pinning the tier did to every run", () => {
    expect(gradeSealedAttempt([], 4, "harness")).toBe("view");
    // The default is `harness`, so a caller that has not derived a tier keeps
    // the behaviour the seal had before the column existed.
    expect(gradeSealedAttempt([], 4)).toBe("view");
  });

  it("never reaches retry: no producer reports a reproducible run here", () => {
    expect(gradeSealedAttempt([], 99, "gateway")).not.toBe("retry");
  });

  it("falls to inspect on a gap that hides what was said (negative)", () => {
    expect(gradeSealedAttempt(["body_missing"], 4, "gateway")).toBe("inspect");
    expect(gradeSealedAttempt([], 0, "gateway")).toBe("inspect");
  });
});
