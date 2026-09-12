/**
 * Unit tests for stripe-sync's drift comparison.
 *
 * #1371 is about a Stripe sync that reported success while reconciling
 * nothing. The dry run is the answer to "have plans drifted", so a dry run
 * that says `UPDATE` for every product whether or not anything differs is the
 * same defect wearing a different hat: it is a report nobody can act on, and
 * six yellow lines read as six drifted products.
 */
import { describe, expect, it } from "vitest";
import { productDiffersFromDesired } from "./stripe-sync";

// Typed explicitly rather than inferred. An inferred literal gives `metadata`
// the exact three keys, which then rejects both a fixture that drops one and a
// fixture that adds a foreign one — the two cases these tests exist to cover.
interface DesiredProduct {
  name: string;
  active?: boolean;
  metadata: Record<string, string>;
}

const desired: DesiredProduct = {
  name: "Build",
  active: true,
  metadata: { oxagen_slug: "build-v2", oxagen_version: "v2", tier: "build" },
};

const existing = (over: Partial<DesiredProduct> = {}) => ({
  name: desired.name,
  active: desired.active ?? true,
  metadata: { ...desired.metadata },
  ...over,
});

describe("productDiffersFromDesired", () => {
  it("reports no difference when the product already matches", () => {
    expect(productDiffersFromDesired(existing(), desired)).toBe(false);
  });

  it("reports a difference when the display name changed", () => {
    expect(
      productDiffersFromDesired(existing({ name: "Build (legacy)" }), desired),
    ).toBe(true);
  });

  it("reports a difference when the product was archived in Stripe", () => {
    expect(productDiffersFromDesired(existing({ active: false }), desired)).toBe(
      true,
    );
  });

  it("reports a difference when a managed metadata value changed", () => {
    expect(
      productDiffersFromDesired(
        existing({ metadata: { ...desired.metadata, tier: "scale" } }),
        desired,
      ),
    ).toBe(true);
  });

  it("reports a difference when a managed metadata key is missing entirely", () => {
    const { tier: _dropped, ...withoutTier } = desired.metadata;
    expect(
      productDiffersFromDesired(existing({ metadata: withoutTier }), desired),
    ).toBe(true);
  });

  // The comparison is a SUBSET check. A key this script does not manage was put
  // there by something else, and calling it drift would make every run report
  // an update forever — the same "report that cannot be acted on" failure, in
  // the other direction.
  it("ignores metadata keys the script does not manage", () => {
    expect(
      productDiffersFromDesired(
        existing({
          metadata: { ...desired.metadata, set_by_a_human_in_the_dashboard: "1" },
        }),
        desired,
      ),
    ).toBe(false);
  });

  it("treats absent metadata as a difference rather than throwing", () => {
    expect(
      productDiffersFromDesired(
        { name: desired.name, active: true, metadata: undefined as never },
        desired,
      ),
    ).toBe(true);
  });
});
