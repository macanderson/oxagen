// alert.test.tsx — unit tests for the Alert variant map (alertVariants()).
// Exercises the cva() map directly so it runs without a DOM renderer, matching
// the button.test.tsx convention.

import { describe, expect, it } from "vitest";
import { alertVariants } from "./alert";

describe("alertVariants", () => {
  it("includes the base banner classes", () => {
    const cls = alertVariants({});
    expect(cls).toContain("relative");
    expect(cls).toContain("w-full");
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("border");
  });

  it("defaults to the neutral card variant", () => {
    const cls = alertVariants({});
    expect(cls).toContain("bg-card");
    expect(cls).toContain("text-card-foreground");
  });

  it("maps each semantic variant to its token + readable foreground", () => {
    expect(alertVariants({ variant: "info" })).toContain("bg-info/10");
    expect(alertVariants({ variant: "info" })).toContain("[&>svg]:text-info");
    expect(alertVariants({ variant: "success" })).toContain("bg-success/10");
    expect(alertVariants({ variant: "success" })).toContain("[&>svg]:text-success");
    expect(alertVariants({ variant: "warning" })).toContain("bg-warning/10");
    expect(alertVariants({ variant: "error" })).toContain("bg-destructive/10");
    // Body text stays on the readable --foreground token for all semantic variants.
    for (const v of ["info", "success", "warning", "error"] as const) {
      expect(alertVariants({ variant: v })).toContain("text-foreground");
    }
  });
});
