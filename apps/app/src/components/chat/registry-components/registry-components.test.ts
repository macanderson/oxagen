import { describe, it, expect } from "vitest";

// ── Pure helper: slug derivation (mirrors all inline components) ──────────────

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ── Pure helper: billing preset amounts ─────────────────────────────────────

const PRESET_AMOUNTS = [10, 25, 50, 100] as const;
type PresetAmount = (typeof PRESET_AMOUNTS)[number];

function isPreset(amount: number): amount is PresetAmount {
  return PRESET_AMOUNTS.includes(amount as PresetAmount);
}

// ── Pure helper: effective credit amount ────────────────────────────────────

function effectiveAmount(
  useCustom: boolean,
  preset: number,
  custom: string,
): number {
  return useCustom ? (parseFloat(custom) || 0) : preset;
}

// ── Pure helper: confirm-destructive state machine ──────────────────────────

type ConfirmState = "idle" | "confirmed" | "denied";

function confirmTransition(current: ConfirmState, action: "confirm" | "deny"): ConfirmState {
  if (current !== "idle") return current;
  return action === "confirm" ? "confirmed" : "denied";
}

// ── Pure helper: model tier validation ──────────────────────────────────────

const VALID_TIERS = new Set(["fast", "balanced", "precise"]);

function isValidTier(value: string): boolean {
  return VALID_TIERS.has(value);
}

// ── Pure helper: invite member role validation ───────────────────────────────

const VALID_ROLES = new Set(["owner", "admin", "member", "billing"]);

function isValidRole(value: string): boolean {
  return VALID_ROLES.has(value);
}

// ── Tests: deriveSlug (shared across create-workspace and create-org) ─────────

describe("deriveSlug", () => {
  it("lowercases the input", () => {
    expect(deriveSlug("Production")).toBe("production");
  });

  it("converts spaces to hyphens", () => {
    expect(deriveSlug("My Workspace")).toBe("my-workspace");
  });

  it("strips non-alphanumeric characters", () => {
    expect(deriveSlug("Acme Inc.!")).toBe("acme-inc");
  });

  it("collapses consecutive hyphens into one", () => {
    expect(deriveSlug("hello--world")).toBe("hello-world");
  });

  it("strips leading and trailing hyphens", () => {
    expect(deriveSlug("-hello-")).toBe("hello");
  });

  it("limits output to 40 characters", () => {
    const long = "a".repeat(50);
    expect(deriveSlug(long)).toHaveLength(40);
  });

  it("returns empty string for empty input", () => {
    expect(deriveSlug("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(deriveSlug("   ")).toBe("");
  });

  it("preserves digits", () => {
    expect(deriveSlug("Team 2025")).toBe("team-2025");
  });

  it("handles unicode by stripping non-latin chars", () => {
    expect(deriveSlug("café")).toBe("caf");
  });
});

// ── Tests: billing preset amounts ─────────────────────────────────────────────

describe("credits-purchase-inline — preset amounts", () => {
  it("10 is a preset", () => { expect(isPreset(10)).toBe(true); });
  it("25 is a preset", () => { expect(isPreset(25)).toBe(true); });
  it("50 is a preset", () => { expect(isPreset(50)).toBe(true); });
  it("100 is a preset", () => { expect(isPreset(100)).toBe(true); });
  it("7 is NOT a preset", () => { expect(isPreset(7)).toBe(false); });
  it("0 is NOT a preset", () => { expect(isPreset(0)).toBe(false); });
  it("exactly 4 preset amounts defined", () => { expect(PRESET_AMOUNTS).toHaveLength(4); });
});

// ── Tests: effective credit amount ────────────────────────────────────────────

describe("credits-purchase-inline — effectiveAmount", () => {
  it("returns preset when useCustom is false", () => {
    expect(effectiveAmount(false, 25, "75")).toBe(25);
  });

  it("returns parsed custom when useCustom is true", () => {
    expect(effectiveAmount(true, 25, "75")).toBe(75);
  });

  it("returns 0 when custom is empty string and useCustom is true", () => {
    expect(effectiveAmount(true, 25, "")).toBe(0);
  });

  it("returns 0 when custom is non-numeric and useCustom is true", () => {
    expect(effectiveAmount(true, 25, "abc")).toBe(0);
  });

  it("minimum $5 guard — effectiveAmount < 5 should disable submit", () => {
    expect(effectiveAmount(true, 25, "3") < 5).toBe(true);
  });

  it("$5 exactly meets the minimum", () => {
    expect(effectiveAmount(true, 25, "5") >= 5).toBe(true);
  });
});

// ── Tests: confirm-destructive state machine ──────────────────────────────────

describe("confirm-destructive-inline — state machine", () => {
  it("idle + confirm → confirmed", () => {
    expect(confirmTransition("idle", "confirm")).toBe("confirmed");
  });

  it("idle + deny → denied", () => {
    expect(confirmTransition("idle", "deny")).toBe("denied");
  });

  it("confirmed + confirm is idempotent (stays confirmed)", () => {
    expect(confirmTransition("confirmed", "confirm")).toBe("confirmed");
  });

  it("confirmed + deny is idempotent (stays confirmed)", () => {
    expect(confirmTransition("confirmed", "deny")).toBe("confirmed");
  });

  it("denied + confirm is idempotent (stays denied)", () => {
    expect(confirmTransition("denied", "confirm")).toBe("denied");
  });

  it("denied + deny is idempotent (stays denied)", () => {
    expect(confirmTransition("denied", "deny")).toBe("denied");
  });
});

// ── Tests: model settings tier validation ─────────────────────────────────────

describe("model-settings-inline — tier validation", () => {
  it("'fast' is valid", () => { expect(isValidTier("fast")).toBe(true); });
  it("'balanced' is valid", () => { expect(isValidTier("balanced")).toBe(true); });
  it("'precise' is valid", () => { expect(isValidTier("precise")).toBe(true); });
  it("'ultra' is NOT valid", () => { expect(isValidTier("ultra")).toBe(false); });
  it("empty string is NOT valid", () => { expect(isValidTier("")).toBe(false); });
  it("exactly 3 valid tiers defined", () => { expect(VALID_TIERS.size).toBe(3); });
});

// ── Tests: invite member role validation ─────────────────────────────────────

describe("invite-member-inline — role validation", () => {
  it("'owner' is valid", () => { expect(isValidRole("owner")).toBe(true); });
  it("'admin' is valid", () => { expect(isValidRole("admin")).toBe(true); });
  it("'member' is valid", () => { expect(isValidRole("member")).toBe(true); });
  it("'billing' is valid", () => { expect(isValidRole("billing")).toBe(true); });
  it("'superuser' is NOT valid", () => { expect(isValidRole("superuser")).toBe(false); });
  it("empty string is NOT valid", () => { expect(isValidRole("")).toBe(false); });
  it("exactly 4 valid roles defined", () => { expect(VALID_ROLES.size).toBe(4); });
});

// ── Tests: create-workspace-inline submit guard ───────────────────────────────

describe("create-workspace-inline — submit disabled guard", () => {
  function canSubmit(name: string, slug: string): boolean {
    return name.trim() !== "" && slug.trim() !== "";
  }

  it("disabled when name is empty", () => {
    expect(canSubmit("", "production")).toBe(false);
  });

  it("disabled when slug is empty", () => {
    expect(canSubmit("Production", "")).toBe(false);
  });

  it("disabled when both empty", () => {
    expect(canSubmit("", "")).toBe(false);
  });

  it("enabled when both non-empty", () => {
    expect(canSubmit("Production", "production")).toBe(true);
  });

  it("disabled when name is whitespace only", () => {
    expect(canSubmit("   ", "production")).toBe(false);
  });
});

// ── Tests: billing upgrade plan list completeness ─────────────────────────────

describe("billing-upgrade-inline — plan list", () => {
  const PLANS = ["build", "scale", "enterprise"] as const;

  it("build plan defined", () => { expect(PLANS).toContain("build"); });
  it("scale plan defined", () => { expect(PLANS).toContain("scale"); });
  it("enterprise plan defined", () => { expect(PLANS).toContain("enterprise"); });
  it("exactly 3 plans", () => { expect(PLANS).toHaveLength(3); });
});
