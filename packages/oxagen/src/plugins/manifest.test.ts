import { describe, expect, it } from "vitest";
import { oxagenPluginManifestSchema } from "./manifest";

const validManifest = {
  id: "oxagen/test-plugin",
  name: "Test Plugin",
  description: "A test plugin for validation purposes.",
  version: "1.0.0",
  // pluginType is a required field (the five-type taxonomy); every real catalog
  // manifest declares it. This fixture must too or the whole schema fails.
  pluginType: "agent_capability" as const,
  tier: "free" as const,
  visibility: "ga" as const,
  category: "media",
  contracts: ["some.capability"],
  scopes: [],
};

describe("oxagenPluginManifestSchema", () => {
  it("accepts a fully valid manifest", () => {
    const result = oxagenPluginManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it("accepts a manifest with optional fields (icon, minPlanTier)", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      icon: "clapperboard",
      minPlanTier: "build",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.icon).toBe("clapperboard");
      expect(result.data.minPlanTier).toBe("build");
    }
  });

  it("accepts a manifest with an optional color field (hex accent for the marketplace card)", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      icon: "video",
      color: "#f59e0b",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.color).toBe("#f59e0b");
    }
  });

  it("accepts a manifest without a color field (color is fully optional)", () => {
    // The validManifest fixture has no color — this ensures the schema does not
    // require it.
    const result = oxagenPluginManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.color).toBeUndefined();
    }
  });

  it("accepts all valid tier values", () => {
    for (const tier of ["free", "premium"] as const) {
      const result = oxagenPluginManifestSchema.safeParse({
        ...validManifest,
        tier,
      });
      expect(result.success, `tier "${tier}" should be valid`).toBe(true);
    }
  });

  it("accepts all valid visibility values", () => {
    for (const visibility of ["hidden", "preview", "beta", "ga"] as const) {
      const result = oxagenPluginManifestSchema.safeParse({
        ...validManifest,
        visibility,
      });
      expect(result.success, `visibility "${visibility}" should be valid`).toBe(
        true,
      );
    }
  });

  it("accepts all valid minPlanTier values", () => {
    for (const minPlanTier of [
      "free",
      "build",
      "scale",
      "enterprise",
    ] as const) {
      const result = oxagenPluginManifestSchema.safeParse({
        ...validManifest,
        minPlanTier,
      });
      expect(
        result.success,
        `minPlanTier "${minPlanTier}" should be valid`,
      ).toBe(true);
    }
  });

  // ── id format ───────────────────────────────────────────────────────────────

  it("rejects an id without a slash (missing namespace)", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      id: "my-plugin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an id with uppercase letters", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      id: "oxagen/MyPlugin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an id with trailing slash", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      id: "oxagen/test-plugin/",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an id that is empty", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      id: "",
    });
    expect(result.success).toBe(false);
  });

  // ── contracts ───────────────────────────────────────────────────────────────

  it("rejects an empty contracts array", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      contracts: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one contract/i);
    }
  });

  it("rejects contracts with empty-string entries", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      contracts: [""],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty contracts array when the pack ships sandbox templates (§6)", () => {
    // A template-distribution pack claims no capability contract — its payload is
    // the portable sandbox template(s) it seeds on install.
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      contracts: [],
      sandboxTemplates: [
        {
          kind: "oxagen.sandbox-template",
          version: 1,
          name: "SWE-bench prewarmed",
          slug: "swe-bench-prewarmed",
          provider: "modal",
          resources: { vcpu: 2, memoryMb: 4096 },
          network: { mode: "public" },
          tools: [{ kind: "capability", ref: "execute_code" }],
          secretKeys: [{ key: "AI_GATEWAY_API_KEY", required: true }],
        },
      ],
    });
    expect(
      result.success,
      result.success ? "" : JSON.stringify(result.error.issues),
    ).toBe(true);
  });

  // ── version ─────────────────────────────────────────────────────────────────

  it("rejects a non-semver version string", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      version: "v1.0.0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a partial semver version (missing patch)", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      version: "1.0",
    });
    expect(result.success).toBe(false);
  });

  // ── tier / visibility ────────────────────────────────────────────────────────

  it("rejects an unknown tier value", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      tier: "enterprise",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown visibility value", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      visibility: "public",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown minPlanTier value", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      minPlanTier: "pro",
    });
    expect(result.success).toBe(false);
  });

  // ── required fields ──────────────────────────────────────────────────────────

  it("rejects a manifest missing the name field", () => {
    const { name: _name, ...rest } = validManifest;
    const result = oxagenPluginManifestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a manifest with an empty description", () => {
    const result = oxagenPluginManifestSchema.safeParse({
      ...validManifest,
      description: "",
    });
    expect(result.success).toBe(false);
  });
});
