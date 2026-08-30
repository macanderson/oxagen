/**
 * Unit tests for inferDomains (@oxagen/code-graph).
 *
 * Strategy: inject a mock DomainAI so no real model calls are made.
 * Tests verify the mapping logic, confidence threshold enforcement,
 * input validation (empty files), and the path guard (unknown paths rejected).
 */
import { describe, it, expect, vi } from "vitest";
import { inferDomains } from "../domains";
import type { DomainAI, DomainMap } from "../domains";

// ---------------------------------------------------------------------------
// Mock AI factory — returns a fixed domain → filePaths response
// ---------------------------------------------------------------------------

interface MockDomain {
  name: string;
  description?: string;
  filePaths: string[];
  confidence: number;
}

function makeMockAI(domains: MockDomain[]): DomainAI {
  return {
    generateObject: vi.fn().mockResolvedValue({
      object: {
        domains: domains.map((d) => ({
          name: d.name,
          description: d.description ?? `${d.name} domain`,
          filePaths: d.filePaths,
          confidence: d.confidence,
        })),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inferDomains", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it("maps files to domain slugs from a confident LLM response", async () => {
    const files = [
      "src/payments/charge.ts",
      "src/payments/refund.ts",
      "src/auth/login.ts",
      "src/auth/session.ts",
    ];

    const ai = makeMockAI([
      {
        name: "payments",
        filePaths: ["src/payments/charge.ts", "src/payments/refund.ts"],
        confidence: 0.9,
      },
      {
        name: "auth",
        filePaths: ["src/auth/login.ts", "src/auth/session.ts"],
        confidence: 0.85,
      },
    ]);

    const result: DomainMap = await inferDomains({ files }, ai);

    expect(result.size).toBe(4);
    expect(result.get("src/payments/charge.ts")).toBe("payments");
    expect(result.get("src/payments/refund.ts")).toBe("payments");
    expect(result.get("src/auth/login.ts")).toBe("auth");
    expect(result.get("src/auth/session.ts")).toBe("auth");
  });

  // ── Empty input ────────────────────────────────────────────────────────────

  it("returns an empty map without calling AI when files is empty", async () => {
    const ai: DomainAI = { generateObject: vi.fn() };

    const result = await inferDomains({ files: [] }, ai);

    expect(result.size).toBe(0);
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  // ── Confidence threshold ───────────────────────────────────────────────────

  it("excludes domains below the 0.55 confidence threshold", async () => {
    const files = ["src/payments/invoice.ts", "src/notifications/email.ts"];

    const ai = makeMockAI([
      {
        name: "payments",
        filePaths: ["src/payments/invoice.ts"],
        confidence: 0.8,
      },
      // Just below threshold — should be excluded
      {
        name: "notifications",
        filePaths: ["src/notifications/email.ts"],
        confidence: 0.5,
      },
    ]);

    const result = await inferDomains({ files }, ai);

    expect(result.get("src/payments/invoice.ts")).toBe("payments");
    expect(result.has("src/notifications/email.ts")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("includes domains exactly at the 0.55 confidence boundary", async () => {
    const files = ["src/billing/invoice.ts"];

    const ai = makeMockAI([
      {
        name: "billing",
        filePaths: ["src/billing/invoice.ts"],
        confidence: 0.55,
      },
    ]);

    const result = await inferDomains({ files }, ai);

    expect(result.get("src/billing/invoice.ts")).toBe("billing");
  });

  // ── Unknown paths guard ────────────────────────────────────────────────────

  it("silently drops file paths the LLM hallucinated (not in input files)", async () => {
    const files = ["src/real/file.ts"];

    const ai = makeMockAI([
      {
        name: "some-domain",
        filePaths: ["src/real/file.ts", "src/hallucinated/path.ts"],
        confidence: 0.9,
      },
    ]);

    const result = await inferDomains({ files }, ai);

    expect(result.get("src/real/file.ts")).toBe("some-domain");
    expect(result.has("src/hallucinated/path.ts")).toBe(false);
    expect(result.size).toBe(1);
  });

  // ── Dirs derivation ────────────────────────────────────────────────────────

  it("derives top-level dirs from file paths and includes them in the prompt", async () => {
    const files = [
      "apps/api/src/routes.ts",
      "apps/cli/src/index.ts",
      "packages/shared/utils.ts",
    ];

    const ai: DomainAI = {
      generateObject: vi.fn().mockResolvedValue({ object: { domains: [] } }),
    };

    await inferDomains({ files }, ai);

    expect(ai.generateObject).toHaveBeenCalledOnce();
    const callArgs = (ai.generateObject as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      prompt: string;
      system: string;
    };
    // Should mention the top-level dirs: apps, packages
    expect(callArgs.prompt).toContain("apps");
    expect(callArgs.prompt).toContain("packages");
  });

  it("uses caller-supplied dirs when provided", async () => {
    const files = ["src/billing/plan.ts"];
    const dirs = ["custom-dir-a", "custom-dir-b"];

    const ai: DomainAI = {
      generateObject: vi.fn().mockResolvedValue({ object: { domains: [] } }),
    };

    await inferDomains({ files, dirs }, ai);

    const callArgs = (ai.generateObject as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      prompt: string;
    };
    expect(callArgs.prompt).toContain("custom-dir-a");
    expect(callArgs.prompt).toContain("custom-dir-b");
  });

  // ── Symbol context ─────────────────────────────────────────────────────────

  it("includes symbol context in the prompt when symbols are provided", async () => {
    const files = ["src/payments/stripe.ts"];
    const symbols = [
      { name: "chargeCard", path: "src/payments/stripe.ts", kind: "function" },
    ];

    const ai: DomainAI = {
      generateObject: vi.fn().mockResolvedValue({ object: { domains: [] } }),
    };

    await inferDomains({ files, symbols }, ai);

    const callArgs = (ai.generateObject as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      prompt: string;
    };
    expect(callArgs.prompt).toContain("chargeCard");
  });

  // ── Multiple files → same domain ───────────────────────────────────────────

  it("handles a single domain covering all files", async () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

    const ai = makeMockAI([
      {
        name: "core",
        filePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
        confidence: 0.75,
      },
    ]);

    const result = await inferDomains({ files }, ai);

    expect(result.size).toBe(3);
    for (const f of files) expect(result.get(f)).toBe("core");
  });

  // ── AI returns no domains ──────────────────────────────────────────────────

  it("returns an empty map when the AI returns an empty domains array", async () => {
    const files = ["config/settings.json"];
    const ai = makeMockAI([]);

    const result = await inferDomains({ files }, ai);

    expect(result.size).toBe(0);
  });
});
