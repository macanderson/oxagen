import { describe, expect, it, vi } from "vitest";
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/ai", () => ({
  resolveModelFundingSource: vi.fn(),
  selectModelFromFunding: vi.fn(),
}));
vi.mock("@oxagen/billing", () => ({ evaluateTurnCreditGate: vi.fn() }));
import { uniqueRunName } from "./run-enrichment";

describe("uniqueRunName", () => {
  it("puts the run id in parentheses after the name", () => {
    expect(uniqueRunName("Repair authentication", "tse_12345678")).toBe(
      "Repair authentication (tse_12345678)",
    );
    expect(uniqueRunName("  Fix login ", "tse_1")).toBe("Fix login (tse_1)");
    expect(uniqueRunName("Fix login", "tse_1")).not.toMatch(/·/);
  });

  it("stays within 80 characters and keeps the id whole", () => {
    const name = uniqueRunName("x".repeat(100), "tse_12345678");
    expect(name).toHaveLength(80);
    expect(name.endsWith(" (tse_12345678)")).toBe(true);
  });
});
