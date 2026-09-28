import { describe, expect, it, vi } from "vitest";
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/ai", () => ({
  resolveModelFundingSource: vi.fn(),
  selectModelFromFunding: vi.fn(),
}));
vi.mock("@oxagen/billing", () => ({ evaluateTurnCreditGate: vi.fn() }));
import {
  accountName,
  accountSummary,
  ENRICHMENT_BUDGET_NOTE,
  partialEvidenceNote,
} from "./run-enrichment";

const points = (text: string | null): number => Array.from(text ?? "").length;

describe("accountName", () => {
  it("keeps the model's name as the session name, with no run id (#4571)", () => {
    expect(accountName("Repair authentication")).toBe("Repair authentication");
    expect(accountName("  Fix   login ")).toBe("Fix login");
  });

  it("strips the quotes a model wraps a name in", () => {
    expect(accountName('"Repair authentication"')).toBe(
      "Repair authentication",
    );
    expect(accountName("“Fix login”")).toBe("Fix login");
  });

  it("never passes 72 code points", () => {
    const name = accountName("Repair the authentication redirect ".repeat(5));
    expect(points(name)).toBeLessThanOrEqual(72);
    expect(name).toMatch(/^Repair the authentication redirect/);
  });

  it("returns null when nothing is left, so the run keeps its title", () => {
    expect(accountName('""')).toBeNull();
    expect(accountName("   ")).toBeNull();
  });
});

describe("accountSummary", () => {
  const long = Array.from(
    { length: 6 },
    (_, i) => `Sentence ${i + 1} ${"says more ".repeat(12)}.`,
  ).join(" ");

  it("keeps a short summary as written", () => {
    expect(accountSummary("Fixed the redirect.", "")).toBe(
      "Fixed the redirect.",
    );
  });

  it("keeps at most three sentences and 400 code points", () => {
    const summary = accountSummary(long, "");
    expect(points(summary)).toBeLessThanOrEqual(400);
    expect(summary).toContain("Sentence 1");
    expect(summary).not.toContain("Sentence 4");
    expect(accountSummary("One. Two. Three. Four.", "")).toBe(
      "One. Two. Three.",
    );
  });

  it("keeps the notes whole and the total within 400", () => {
    const notes = partialEvidenceNote(3) + ENRICHMENT_BUDGET_NOTE;
    const summary = accountSummary(long, notes);
    expect(points(summary)).toBeLessThanOrEqual(400);
    expect(summary.endsWith(notes)).toBe(true);
    expect(summary).toContain("Sentence 1");
  });
});

describe("partialEvidenceNote", () => {
  it("says how many bodies were unavailable, and nothing when none were", () => {
    expect(partialEvidenceNote(2)).toBe(
      " Evidence is partial: 2 recorded bodies were unavailable.",
    );
    expect(partialEvidenceNote(0)).toBe("");
  });
});
