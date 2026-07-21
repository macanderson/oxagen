import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const seedSource = readFileSync(
  join(import.meta.dirname, "seed-iam-defaults.ts"),
  "utf8",
);

describe("Agent Operator restricted capability grants", () => {
  it("honors per-capability approval metadata for restricted categories", () => {
    // A restricted billing capability may be low-risk but still declare
    // requiresApproval. Risk alone would incorrectly grant Operator access.
    expect(seedSource).toMatch(/cap\.agent\?\.requiresApproval/);
  });
});
