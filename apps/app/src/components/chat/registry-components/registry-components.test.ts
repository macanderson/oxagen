import { describe, it, expect } from "vitest";

/**
 * ⚠ READ THIS BEFORE TRUSTING THIS FILE.
 *
 * Every helper below is a COPY of logic that lives in an inline registry
 * component — nothing here is imported from the components themselves. These
 * tests pin the intended behaviour of the copies, so they can NOT catch a
 * regression in create-workspace-inline, credits-purchase-inline,
 * confirm-destructive-inline, model-settings-inline, invite-member-inline, or
 * billing-upgrade-inline: change any of those and every assertion here stays
 * green.
 *
 * Real coverage means exporting the helper from its component and importing it
 * here, or rendering the component under jsdom. Do not add new copied helpers.
 */

// ── Pure helper: slug derivation (COPY of the inline components' logic) ───────

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
  return useCustom ? parseFloat(custom) || 0 : preset;
}

// ── Pure helper: confirm-destructive state machine ──────────────────────────

type ConfirmState = "idle" | "confirmed" | "denied";

function confirmTransition(
  current: ConfirmState,
  action: "confirm" | "deny",
): ConfirmState {
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
  it("10 is a preset", () => {
    expect(isPreset(10)).toBe(true);
  });
  it("25 is a preset", () => {
    expect(isPreset(25)).toBe(true);
  });
  it("50 is a preset", () => {
    expect(isPreset(50)).toBe(true);
  });
  it("100 is a preset", () => {
    expect(isPreset(100)).toBe(true);
  });
  it("7 is NOT a preset", () => {
    expect(isPreset(7)).toBe(false);
  });
  it("0 is NOT a preset", () => {
    expect(isPreset(0)).toBe(false);
  });
  it("exactly 4 preset amounts defined", () => {
    expect(PRESET_AMOUNTS).toHaveLength(4);
  });
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
  it("'fast' is valid", () => {
    expect(isValidTier("fast")).toBe(true);
  });
  it("'balanced' is valid", () => {
    expect(isValidTier("balanced")).toBe(true);
  });
  it("'precise' is valid", () => {
    expect(isValidTier("precise")).toBe(true);
  });
  it("'ultra' is NOT valid", () => {
    expect(isValidTier("ultra")).toBe(false);
  });
  it("empty string is NOT valid", () => {
    expect(isValidTier("")).toBe(false);
  });
  it("exactly 3 valid tiers defined", () => {
    expect(VALID_TIERS.size).toBe(3);
  });
});

// ── Tests: invite member role validation ─────────────────────────────────────

describe("invite-member-inline — role validation", () => {
  it("'owner' is valid", () => {
    expect(isValidRole("owner")).toBe(true);
  });
  it("'admin' is valid", () => {
    expect(isValidRole("admin")).toBe(true);
  });
  it("'member' is valid", () => {
    expect(isValidRole("member")).toBe(true);
  });
  it("'billing' is valid", () => {
    expect(isValidRole("billing")).toBe(true);
  });
  it("'superuser' is NOT valid", () => {
    expect(isValidRole("superuser")).toBe(false);
  });
  it("empty string is NOT valid", () => {
    expect(isValidRole("")).toBe(false);
  });
  it("exactly 4 valid roles defined", () => {
    expect(VALID_ROLES.size).toBe(4);
  });
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

  it("build plan defined", () => {
    expect(PLANS).toContain("build");
  });
  it("scale plan defined", () => {
    expect(PLANS).toContain("scale");
  });
  it("enterprise plan defined", () => {
    expect(PLANS).toContain("enterprise");
  });
  it("exactly 3 plans", () => {
    expect(PLANS).toHaveLength(3);
  });
});

// ── Pure helpers: workflow-progress ──────────────────────────────────────────

type WorkflowStatus =
  | "planning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

const TERMINAL_STATUSES = new Set<WorkflowStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function formatElapsed(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : start;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatEta(
  completedTasks: number,
  totalTasks: number,
  startedAt: string | null,
  now: number,
): string {
  if (!startedAt || completedTasks === 0 || totalTasks === 0) return "—";
  const elapsed = now - new Date(startedAt).getTime();
  const rate = completedTasks / elapsed;
  const remaining = totalTasks - completedTasks;
  const etaMs = remaining / rate;
  const etaS = Math.round(etaMs / 1000);
  if (etaS < 60) return `~${etaS}s`;
  return `~${Math.round(etaS / 60)}m`;
}

function progressPct(completedTasks: number, totalTasks: number): number {
  return totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
}

// ── Tests: workflow-progress terminal status detection ────────────────────────

describe("workflow-progress — terminal status detection", () => {
  it("'completed' is terminal", () => {
    expect(isTerminal("completed")).toBe(true);
  });
  it("'failed' is terminal", () => {
    expect(isTerminal("failed")).toBe(true);
  });
  it("'cancelled' is terminal", () => {
    expect(isTerminal("cancelled")).toBe(true);
  });
  it("'running' is NOT terminal", () => {
    expect(isTerminal("running")).toBe(false);
  });
  it("'planning' is NOT terminal", () => {
    expect(isTerminal("planning")).toBe(false);
  });
  it("exactly 3 terminal statuses", () => {
    expect(TERMINAL_STATUSES.size).toBe(3);
  });
});

// ── Tests: workflow-progress elapsed time formatting ─────────────────────────

describe("workflow-progress — formatElapsed", () => {
  it("returns '—' when startedAt is null", () => {
    expect(formatElapsed(null, null)).toBe("—");
  });

  it("returns ms string for sub-second elapsed", () => {
    const start = new Date("2026-06-07T10:00:00.000Z").toISOString();
    const end = new Date("2026-06-07T10:00:00.500Z").toISOString();
    expect(formatElapsed(start, end)).toBe("500ms");
  });

  it("returns seconds string for sub-minute elapsed", () => {
    const start = new Date("2026-06-07T10:00:00.000Z").toISOString();
    const end = new Date("2026-06-07T10:00:30.000Z").toISOString();
    expect(formatElapsed(start, end)).toBe("30s");
  });

  it("returns m+s string for multi-minute elapsed", () => {
    const start = new Date("2026-06-07T10:00:00.000Z").toISOString();
    const end = new Date("2026-06-07T10:02:45.000Z").toISOString();
    expect(formatElapsed(start, end)).toBe("2m 45s");
  });

  it("uses completedAt when provided (does not use live clock)", () => {
    const start = new Date("2026-06-07T10:00:00.000Z").toISOString();
    const end = new Date("2026-06-07T10:01:00.000Z").toISOString();
    expect(formatElapsed(start, end)).toBe("1m 0s");
  });
});

// ── Tests: workflow-progress progress percentage ──────────────────────────────

describe("workflow-progress — progressPct", () => {
  it("returns 0 when totalTasks is 0", () => {
    expect(progressPct(0, 0)).toBe(0);
  });

  it("returns 0 when nothing is completed", () => {
    expect(progressPct(0, 10)).toBe(0);
  });

  it("returns 50 when half complete", () => {
    expect(progressPct(5, 10)).toBe(50);
  });

  it("returns 100 when all complete", () => {
    expect(progressPct(10, 10)).toBe(100);
  });

  it("rounds to nearest integer", () => {
    expect(progressPct(1, 3)).toBe(33);
  });
});

// ── Tests: workflow-progress ETA calculation ─────────────────────────────────

describe("workflow-progress — formatEta", () => {
  it("returns '—' when startedAt is null", () => {
    expect(formatEta(5, 10, null, Date.now())).toBe("—");
  });

  it("returns '—' when completedTasks is 0 (avoid division by zero)", () => {
    expect(formatEta(0, 10, new Date().toISOString(), Date.now())).toBe("—");
  });

  it("returns '—' when totalTasks is 0", () => {
    expect(formatEta(0, 0, new Date().toISOString(), Date.now())).toBe("—");
  });

  it("returns seconds ETA when remaining < 60s", () => {
    const now = Date.now();
    // 5 tasks done in 10000ms → rate = 0.5/s → 5 remaining → 10s ETA
    const start = new Date(now - 10000).toISOString();
    const eta = formatEta(5, 10, start, now);
    expect(eta).toBe("~10s");
  });

  it("returns minutes ETA when remaining >= 60s", () => {
    const now = Date.now();
    // 1 task done in 1000ms → rate = 1/1000ms → 99 remaining → 99s ≈ 2m ETA
    const start = new Date(now - 1000).toISOString();
    const eta = formatEta(1, 100, start, now);
    expect(eta).toBe("~2m");
  });
});

// ── Tests: workflow-progress status-to-polling-stop mapping ──────────────────

describe("workflow-progress — polling stops on terminal status", () => {
  const cases: Array<{ status: WorkflowStatus; shouldStop: boolean }> = [
    { status: "planning", shouldStop: false },
    { status: "running", shouldStop: false },
    { status: "completed", shouldStop: true },
    { status: "failed", shouldStop: true },
    { status: "cancelled", shouldStop: true },
  ];

  for (const { status, shouldStop } of cases) {
    it(`status '${status}' → shouldStop=${shouldStop}`, () => {
      expect(isTerminal(status)).toBe(shouldStop);
    });
  }
});

// ── Tests: coding-agent artifact card ids resolve in the registry ───────────
// Regression coverage for the Phase 3 additions — "code-diff", "terminal-trace",
// and "file-tree" are stable ids persisted in content_blocks; a typo or
// dropped entry here would silently fall back to UnknownComponentCard in chat.

describe("CHAT_COMPONENTS registry — coding-agent artifact ids", () => {
  it("registers code-diff, terminal-trace, and file-tree", async () => {
    const { CHAT_COMPONENTS } = await import("../chat-component-registry");
    expect(CHAT_COMPONENTS["code-diff"]).toBeDefined();
    expect(CHAT_COMPONENTS["terminal-trace"]).toBeDefined();
    expect(CHAT_COMPONENTS["file-tree"]).toBeDefined();
  });

  it("each new id's module resolves to a component with a default export", async () => {
    // Cold dynamic import of three non-trivial card modules measured at
    // ~4.9s in isolation (transform + module graph, no test-code slowness) —
    // already at the edge of vitest's 5000ms default, so any concurrent
    // monorepo load tips it into a false-positive timeout. 20s gives real
    // headroom without masking an actual hang.
    const [diffModule, traceModule, treeModule] = await Promise.all([
      import("./code-diff-card"),
      import("./terminal-trace-card"),
      import("./file-tree-card"),
    ]);
    expect(typeof diffModule.default).toBe("function");
    expect(typeof traceModule.default).toBe("function");
    expect(typeof treeModule.default).toBe("function");
  }, 20_000);
});
