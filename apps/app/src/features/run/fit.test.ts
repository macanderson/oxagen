// Model fit on the page (pages/run.md, Model fit; ADR-194): the page computes
// no reading. It draws the one `get_run` stored, and prints the effort the
// record holds. These tests hold the three helpers the rig strip and the Cost
// tab's panel share, so the two cannot disagree: the effort as recorded, the
// reading of a sealed run, and the effort verdict beside the recorded value.
import { describe, expect, it } from "vitest";
import type { RunRow } from "@/data/contracts/runs";
import { effortVerdict, fitOf, runEffort, type RunFit } from "./fit";
import { runRow } from "./run.builders";

/** A stored reading of the builder's seal: a fit model and the effort it read. */
function reading(effort: RunFit["effort"]): RunFit {
  return {
    method: "run-fit/v1",
    readAt: "2026-09-15T08:45:00.000Z",
    sealedAt: "2026-09-15T08:40:00.000Z",
    read: {
      prompts: 1,
      turns: 8,
      steps: 40,
      failed: 0,
      outputTokens: 1_000,
      reasoningTokens: 300,
    },
    model: { verdict: "fit", tier: "sonnet" },
    effort,
  };
}

function run(overrides: Partial<RunRow> = {}): RunRow {
  return runRow({ enforcementTier: "harness", ...overrides });
}

describe("runEffort", () => {
  it("prints the recorded effort with where it was read", () => {
    expect(runEffort(run({ effort: "low", effortSource: "request" }))).toEqual(
      { seen: true, value: "low", source: "request" },
    );
    // A server that predates the source says nothing, and the value is the
    // harness's report, the only place it could have come from then.
    expect(runEffort(run({ effort: "high", effortSource: null }))).toEqual({
      seen: true,
      value: "high",
      source: "harness",
    });
  });

  it.each<[RunRow["enforcementTier"], "not_sent" | "not_proxied"]>([
    ["gateway", "not_sent"],
    ["contained", "not_sent"],
    ["harness", "not_proxied"],
    ["observe", "not_proxied"],
  ])(
    "says why no effort is shown at the %s tier: %s (negative)",
    (enforcementTier, why) => {
      expect(runEffort(run({ enforcementTier, effort: null }))).toEqual({
        seen: false,
        why,
      });
      expect(runEffort(run({ enforcementTier, effort: "" }))).toEqual({
        seen: false,
        why,
      });
      // A row that leaves the effort out, as list_runs does.
      expect(runEffort(run({ enforcementTier }))).toEqual({
        seen: false,
        why,
      });
    },
  );
});

describe("fitOf", () => {
  it("draws the stored reading of a sealed run", () => {
    const fit = reading({ verdict: "unseen", why: "not_proxied" });
    expect(fitOf(run({ fit }))).toBe(fit);
  });

  it("draws no reading for a live run or a run with none stored (negative)", () => {
    const fit = reading({ verdict: "unseen", why: "not_proxied" });
    expect(fitOf(run({ status: "live", sealedAt: null, fit }))).toBeNull();
    expect(fitOf(run({ fit: null }))).toBeNull();
  });
});

describe("effortVerdict", () => {
  it("names the reading's move beside the value the rig prints", () => {
    const over = run({
      effort: "high",
      effortSource: "request",
      fit: reading({
        verdict: "over",
        effort: "high",
        source: "request",
        suggest: "medium",
      }),
    });
    expect(effortVerdict(over)).toEqual({ verdict: "over", suggest: "medium" });
    const fits = run({
      effort: "medium",
      effortSource: "harness",
      fit: reading({ verdict: "fit", effort: "medium", source: "harness" }),
    });
    expect(effortVerdict(fits)).toEqual({ verdict: "fit" });
  });

  it("names no verdict about a value the rig does not print, or with no reading (negative)", () => {
    // The reading read another value than the record now holds.
    expect(
      effortVerdict(
        run({
          effort: "low",
          effortSource: "request",
          fit: reading({
            verdict: "under",
            effort: "medium",
            source: "request",
            suggest: "high",
          }),
        }),
      ),
    ).toBeNull();
    // The record holds no effort, whatever the reading says.
    expect(
      effortVerdict(
        run({
          effort: null,
          fit: reading({ verdict: "fit", effort: "high", source: "harness" }),
        }),
      ),
    ).toBeNull();
    expect(
      effortVerdict(
        run({
          effort: "high",
          fit: reading({ verdict: "unseen", why: "not_sent" }),
        }),
      ),
    ).toBeNull();
    expect(effortVerdict(run({ effort: "high", fit: null }))).toBeNull();
  });
});
