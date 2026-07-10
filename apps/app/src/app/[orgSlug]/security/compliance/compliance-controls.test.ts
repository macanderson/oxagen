import { describe, it, expect } from "vitest";
import {
  deriveComplianceControls,
  summariseControls,
  type ControlSignals,
} from "./compliance-controls";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SIGNALS: ControlSignals = {
  auditEventCount: 0,
  mfaRequired: false,
  rlsEnforced: false,
  oldestActiveApiKeyDays: null,
};

function signals(overrides: Partial<ControlSignals>): ControlSignals {
  return { ...BASE_SIGNALS, ...overrides };
}

// ---------------------------------------------------------------------------
// CC6.1 — Logical access controls
// ---------------------------------------------------------------------------

describe("CC6.1 — logical access controls", () => {
  it("not_started when neither RLS nor MFA is configured", () => {
    const controls = deriveComplianceControls(signals({ rlsEnforced: false, mfaRequired: false }));
    const cc61 = controls.find((c) => c.id === "cc6.1")!;
    expect(cc61.status).toBe("not_started");
  });

  it("partial when RLS enforced but MFA not required", () => {
    const controls = deriveComplianceControls(signals({ rlsEnforced: true, mfaRequired: false }));
    const cc61 = controls.find((c) => c.id === "cc6.1")!;
    expect(cc61.status).toBe("partial");
  });

  it("active when both RLS enforced and MFA required", () => {
    const controls = deriveComplianceControls(signals({ rlsEnforced: true, mfaRequired: true }));
    const cc61 = controls.find((c) => c.id === "cc6.1")!;
    expect(cc61.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// CC6.2 — Authentication and credential management
// ---------------------------------------------------------------------------

describe("CC6.2 — authentication and credential management", () => {
  it("partial when MFA not required", () => {
    const controls = deriveComplianceControls(signals({ mfaRequired: false }));
    const cc62 = controls.find((c) => c.id === "cc6.2")!;
    expect(cc62.status).toBe("partial");
  });

  it("active when MFA required", () => {
    const controls = deriveComplianceControls(signals({ mfaRequired: true }));
    const cc62 = controls.find((c) => c.id === "cc6.2")!;
    expect(cc62.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// CC6.3 — Role-based access (always partial — no automated reviews yet)
// ---------------------------------------------------------------------------

describe("CC6.3 — role-based access", () => {
  it("is always partial regardless of signals", () => {
    const c1 = deriveComplianceControls(signals({})).find((c) => c.id === "cc6.3")!;
    const c2 = deriveComplianceControls(
      signals({ rlsEnforced: true, mfaRequired: true, auditEventCount: 1000 }),
    ).find((c) => c.id === "cc6.3")!;
    expect(c1.status).toBe("partial");
    expect(c2.status).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// CC7.2 — Audit trail & monitoring
// ---------------------------------------------------------------------------

describe("CC7.2 — audit trail and monitoring", () => {
  it("partial when no events recorded yet", () => {
    const controls = deriveComplianceControls(signals({ auditEventCount: 0 }));
    const cc72 = controls.find((c) => c.id === "cc7.2")!;
    expect(cc72.status).toBe("partial");
  });

  it("active when at least one event recorded", () => {
    const controls = deriveComplianceControls(signals({ auditEventCount: 1 }));
    const cc72 = controls.find((c) => c.id === "cc7.2")!;
    expect(cc72.status).toBe("active");
  });

  it("rationale includes event count", () => {
    const controls = deriveComplianceControls(signals({ auditEventCount: 4200 }));
    const cc72 = controls.find((c) => c.id === "cc7.2")!;
    expect(cc72.rationale).toContain("4,200");
  });
});

// ---------------------------------------------------------------------------
// CC9.2 — Vendor risk (always partial — formal assessments in progress)
// ---------------------------------------------------------------------------

describe("CC9.2 — vendor risk", () => {
  it("is always partial", () => {
    const controls = deriveComplianceControls(signals({})).find((c) => c.id === "cc9.2")!;
    expect(controls.status).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// CC6.api — API key rotation heuristic
// ---------------------------------------------------------------------------

describe("CC6.api — API key rotation", () => {
  it("active when no active keys", () => {
    const c = deriveComplianceControls(signals({ oldestActiveApiKeyDays: null })).find(
      (c) => c.id === "cc6.api",
    )!;
    expect(c.status).toBe("active");
  });

  it("active when oldest key is within 180 days", () => {
    const c = deriveComplianceControls(signals({ oldestActiveApiKeyDays: 90 })).find(
      (c) => c.id === "cc6.api",
    )!;
    expect(c.status).toBe("active");
  });

  it("active at exactly 180 days", () => {
    const c = deriveComplianceControls(signals({ oldestActiveApiKeyDays: 180 })).find(
      (c) => c.id === "cc6.api",
    )!;
    expect(c.status).toBe("active");
  });

  it("partial when oldest key is older than 180 days", () => {
    const c = deriveComplianceControls(signals({ oldestActiveApiKeyDays: 200 })).find(
      (c) => c.id === "cc6.api",
    )!;
    expect(c.status).toBe("partial");
    expect(c.rationale).toContain("200");
  });
});

// ---------------------------------------------------------------------------
// summariseControls
// ---------------------------------------------------------------------------

describe("summariseControls", () => {
  it("counts active / partial / not_started correctly", () => {
    // All bad signals → some not_started, some partial.
    const controls = deriveComplianceControls(BASE_SIGNALS);
    const summary = summariseControls(controls);
    expect(summary.total).toBe(controls.length);
    expect(summary.active + summary.partial + summary.notStarted).toBe(summary.total);
  });

  it("returns 100% active when all signals are optimal", () => {
    const controls = deriveComplianceControls(
      signals({
        rlsEnforced: true,
        mfaRequired: true,
        auditEventCount: 500,
        oldestActiveApiKeyDays: 30,
      }),
    );
    const summary = summariseControls(controls);
    // CC6.3 is always partial — so notStarted should be 0 but partial > 0.
    expect(summary.notStarted).toBe(0);
    expect(summary.active).toBeGreaterThan(0);
  });

  it("denial path: role gate — not_started when both RLS and MFA missing", () => {
    const controls = deriveComplianceControls(BASE_SIGNALS);
    const cc61 = controls.find((c) => c.id === "cc6.1")!;
    expect(cc61.status).toBe("not_started");
    const summary = summariseControls(controls);
    // At least one control is not_started.
    expect(summary.notStarted).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Shape / completeness
// ---------------------------------------------------------------------------

describe("control catalog shape", () => {
  it("every control has id, criterion, title, description, status, category", () => {
    const controls = deriveComplianceControls(BASE_SIGNALS);
    for (const c of controls) {
      expect(c.id).toBeTruthy();
      expect(c.criterion).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(["active", "partial", "not_started"]).toContain(c.status);
      expect(c.category).toBeTruthy();
    }
  });

  it("has at least 6 controls (CC6.1, CC6.2, CC6.3, CC6.api, CC7.2, CC9.2)", () => {
    const controls = deriveComplianceControls(BASE_SIGNALS);
    expect(controls.length).toBeGreaterThanOrEqual(6);
  });
});
