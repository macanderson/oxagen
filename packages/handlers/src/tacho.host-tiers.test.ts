/**
 * The tier a host's apps reach (ADR-078). This is the fact every fleet
 * surface reads to decide what words it may use about a machine, so the
 * mapping is pinned here rather than inferred at each surface.
 */
import { describe, expect, it } from "vitest";
import { TACHO_HARNESS_TIERS, tachoHarnessSchema } from "@oxagen/tacho";
import { tiersFor } from "./tacho.host.list";

describe("tiersFor", () => {
  it("files each built-in harness on the tier it actually reaches", () => {
    expect(tiersFor(["claude-code", "codex", "stella"])).toEqual({
      "claude-code": "harness",
      codex: "harness",
      stella: "harness",
    });
    expect(tiersFor(["claude-desktop"])).toEqual({
      "claude-desktop": "gateway",
    });
  });

  it("covers every harness the wire schema admits", () => {
    // A harness added to the enum without a tier would fall to the default
    // below; this fails first, so the mapping is a decision rather than a
    // fallback.
    const tiers = tiersFor(tachoHarnessSchema.options);
    for (const harness of tachoHarnessSchema.options) {
      expect(tiers[harness]).toBe(TACHO_HARNESS_TIERS[harness]);
    }
  });

  it("carries both tiers for the machine that has both, which is normal", () => {
    expect(tiersFor(["claude-code", "claude-desktop"])).toEqual({
      "claude-code": "harness",
      "claude-desktop": "gateway",
    });
  });

  it("files an unknown name as wrapped, the tier with the caveat", () => {
    // Today an unknown name is a custom agent calling `tacho hook --agent`,
    // which is wrapped by construction. Whatever it is, defaulting to
    // `harness` claims client-attested reporting; defaulting to `gateway`
    // would claim Oxagen refused its calls server-side, which would be a
    // stronger claim than the record supports.
    expect(tiersFor(["my-reviewer"])).toEqual({ "my-reviewer": "harness" });
  });

  it("is empty for a host with no harnesses", () => {
    expect(tiersFor([])).toEqual({});
  });

  it("does not invent an entry for a harness the host does not have", () => {
    const tiers = tiersFor(["claude-code"]);
    expect(Object.keys(tiers)).toEqual(["claude-code"]);
    expect(tiers["claude-desktop"]).toBeUndefined();
  });
});
