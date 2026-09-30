/**
 * The Policy line (#4570). It used to name permission rules alone, while the
 * mode decides the contained-tier check and the stale-bundle check too, and
 * the desktop app showed any mode that was not `enforce` as `observe`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluatePreToolUse,
  type EvaluationInput,
  type PolicyDecisionValue,
} from "../host/bundle";
import { bundleSigner, unsignedBundle } from "../host/test-support";
import type { PolicyBundle } from "../wire";
import { POLICY_MODE_TEXT, policyModeText } from "./policy-mode";

describe("the Policy line", () => {
  it("describes observe as recorded, with the budget and model limits still in force", () => {
    expect(policyModeText("observe")).toBe(
      "observe: Oxagen records what the policy would decide on a governed call and lets it go ahead. Budget and model limits still apply to model calls routed through Oxagen.",
    );
  });

  it("describes enforce as able to deny or ask, with the budget and model limits beside it", () => {
    expect(policyModeText("enforce")).toBe(
      "enforce: the policy can deny a governed call or ask first. Budget and model limits also apply to model calls routed through Oxagen.",
    );
  });

  it("no longer scopes either mode to permission rules", () => {
    // The mode governs the whole evaluation below, so a line that names one
    // step of it tells the reader the others do not depend on the mode.
    for (const text of Object.values(POLICY_MODE_TEXT))
      expect(text).not.toContain("permission rule");
  });

  it("names a mode it does not know instead of reading it as observe", () => {
    expect(policyModeText("shadow")).toBe("unknown policy mode: shadow");
    // Checked by name, so a near miss is unknown too.
    expect(policyModeText("Enforce")).toBe("unknown policy mode: Enforce");
    expect(policyModeText("observed")).toBe("unknown policy mode: observed");
  });

  it("says a missing mode is not set", () => {
    expect(policyModeText(undefined)).toBe("unknown policy mode: not set");
    expect(policyModeText(null)).toBe("unknown policy mode: not set");
  });

  it("prints a value that is not a plain word as JSON, so it reads as what it is", () => {
    expect(policyModeText("")).toBe('unknown policy mode: ""');
    expect(policyModeText("en force")).toBe('unknown policy mode: "en force"');
    expect(policyModeText("a\nb")).toBe('unknown policy mode: "a\\nb"');
    expect(policyModeText(1)).toBe("unknown policy mode: 1");
    expect(policyModeText(true)).toBe("unknown policy mode: true");
    expect(policyModeText({ mode: "enforce" })).toBe(
      'unknown policy mode: {"mode":"enforce"}',
    );
    // JSON cannot write a symbol, so it falls back to its string form.
    expect(policyModeText(Symbol("x"))).toBe("unknown policy mode: Symbol(x)");
  });

  it("cuts a long value to one row", () => {
    const text = policyModeText("x".repeat(500));
    expect(text).toBe(`unknown policy mode: ${"x".repeat(64)}...`);
  });
});

/**
 * What each sentence claims, checked against the evaluator it describes.
 * Every decision `evaluatePreToolUse` makes by `bundle.mode` refuses or asks
 * under `enforce` and goes ahead under `observe`, and the decisions the mode
 * does not govern refuse in both.
 */
describe("the sentences agree with the evaluation", () => {
  const signer = bundleSigner();

  function decide(
    mode: PolicyBundle["mode"],
    call: Partial<EvaluationInput>,
    bundle: Partial<Omit<PolicyBundle, "signature">> = {},
  ): PolicyDecisionValue {
    return evaluatePreToolUse({
      bundle: signer.sign(unsignedBundle({ ...bundle, mode })),
      bundleVerified: true,
      hostStatus: "active",
      latestDenyGeneration: { org: 1, workspace: 1 },
      controlReachable: true,
      now: Date.parse("2026-09-10T12:00:00.000Z"),
      context: { cwd: "/repo" },
      toolName: "Read",
      ...call,
    }).decision;
  }

  // The fixture bundle denies `Bash(git push*)`, asks on `Bash(rm *)`, and
  // declares Bash able to change something.
  const governed: Array<{
    what: string;
    call: Partial<EvaluationInput>;
    bundle?: Partial<Omit<PolicyBundle, "signature">>;
    enforce: PolicyDecisionValue;
  }> = [
    {
      what: "a mandate that requires the contained tier",
      call: { toolName: "Read", containmentUnmet: true },
      bundle: { containment: { required: true } },
      enforce: "deny",
    },
    {
      what: "a stale bundle while the control plane is unreachable",
      call: {
        toolName: "Bash",
        toolInput: { command: "ls" },
        latestDenyGeneration: { org: 2, workspace: 1 },
        controlReachable: false,
      },
      enforce: "deny",
    },
    {
      what: "a deny rule",
      call: { toolName: "Bash", toolInput: { command: "git push origin" } },
      enforce: "deny",
    },
    {
      what: "an ask rule",
      call: { toolName: "Bash", toolInput: { command: "rm -rf x" } },
      enforce: "ask",
    },
    {
      what: "a call no rule covers",
      call: { toolName: "Bash", toolInput: { command: "make" } },
      enforce: "ask",
    },
  ];

  for (const { what, call, bundle, enforce } of governed)
    it(`enforce refuses or asks on ${what}, and observe lets it go ahead`, () => {
      expect(decide("enforce", call, bundle)).toBe(enforce);
      expect(decide("observe", call, bundle)).toBe("allow");
    });

  it("refuses in both modes on operator control and on a bundle that does not verify", () => {
    for (const mode of ["observe", "enforce"] as const) {
      expect(decide(mode, { hostStatus: "paused" }), mode).toBe("deny");
      expect(decide(mode, { session: { cancelled: "stop" } }), mode).toBe(
        "deny",
      );
      expect(
        decide(mode, {
          bundleVerified: false,
          toolName: "Bash",
          toolInput: { command: "make" },
        }),
        mode,
      ).toBe("deny");
    }
  });
});

/**
 * The desktop app prints the same sentences from its own copy, because it
 * shares no runtime code with the CLI. Its test reads this file; this test
 * reads its copy, so a change to either side fails whichever package's tests
 * run.
 */
describe("the desktop app's copy", () => {
  const desktop = readFileSync(
    fileURLToPath(
      new URL("../../../../apps/desktop/src/tacho-status.ts", import.meta.url),
    ),
    "utf8",
  );

  it("carries each sentence word for word", () => {
    for (const text of Object.values(POLICY_MODE_TEXT))
      expect(desktop).toContain(JSON.stringify(text));
  });

  it("words an unknown mode the same way", () => {
    expect(desktop).toContain("`unknown policy mode: ${");
    expect(desktop).toContain('"not set"');
    expect(desktop).toContain("/^[!-~]+$/");
    expect(desktop).toContain("RAW_MODE_MAX = 64");
  });
});
