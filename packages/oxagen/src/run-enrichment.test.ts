import { describe, expect, it } from "vitest";
import { runEnrichmentEnabled } from "./run-enrichment";
describe("run enrichment setting", () => {
  it("starts on for existing workspaces", () => {
    for (const settings of [
      null,
      undefined,
      {},
      [],
      { steering: { prompt: true } },
    ])
      expect(runEnrichmentEnabled(settings)).toBe(true);
  });
  it("turns off only for an explicit false and retains unrelated settings", () => {
    expect(
      runEnrichmentEnabled({ runEnrichmentEnabled: false, retention: "full" }),
    ).toBe(false);
    expect(runEnrichmentEnabled({ runEnrichmentEnabled: true })).toBe(true);
  });
});
