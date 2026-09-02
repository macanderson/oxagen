// misc.schema.test.ts — unit tests for miscellaneous tool input schemas.
//
// Covers: system.install.instructions, user.preferences.write,
//         workspace.model.settings.write.
// Pure schema logic; no network / DB / xmcp runtime involved.

import { describe, it, expect } from "vitest";
import { obj } from "./_schema-test-helpers";

// ── system.install.instructions ───────────────────────────────────────────────

import { schema as systemInstallInstructionsSchema } from "./system.install.instructions";

describe("system.install.instructions schema", () => {
  const Schema = obj(systemInstallInstructionsSchema);

  it("accepts all valid client values", () => {
    const validClients = [
      "claude-code",
      "cursor",
      "claude-desktop",
      "codex",
      "vscode",
    ] as const;
    for (const client of validClients) {
      expect(() => Schema.parse({ client })).not.toThrow();
    }
  });

  it("rejects 'windsurf' (not in enum)", () => {
    expect(() => Schema.parse({ client: "windsurf" })).toThrow();
  });

  it("rejects 'copilot' (not in enum)", () => {
    expect(() => Schema.parse({ client: "copilot" })).toThrow();
  });

  it("rejects an empty string client", () => {
    expect(() => Schema.parse({ client: "" })).toThrow();
  });

  it("rejects missing client field", () => {
    expect(() => Schema.parse({})).toThrow();
  });

  it("workspaceSlug is optional — omitting it is valid", () => {
    const result = Schema.parse({ client: "claude-code" });
    expect(result.workspaceSlug).toBeUndefined();
  });

  it("accepts an optional workspaceSlug string", () => {
    const result = Schema.parse({
      client: "cursor",
      workspaceSlug: "my-workspace",
    });
    expect(result.workspaceSlug).toBe("my-workspace");
  });

  it("rejects an invalid client alongside a valid workspaceSlug", () => {
    expect(() =>
      Schema.parse({ client: "vimcopilot", workspaceSlug: "ws-1" }),
    ).toThrow();
  });
});

// ── user.preferences.write ────────────────────────────────────────────────────

import { schema as userPreferencesWriteSchema } from "./user.preferences.write";

describe("user.preferences.write schema", () => {
  const Schema = obj(userPreferencesWriteSchema);

  it("accepts an empty payload (all fields optional)", () => {
    expect(() => Schema.parse({})).not.toThrow();
  });

  it("accepts all valid fontSize values", () => {
    for (const fontSize of ["small", "medium", "large"] as const) {
      expect(() => Schema.parse({ fontSize })).not.toThrow();
    }
  });

  it("rejects an invalid fontSize enum", () => {
    expect(() => Schema.parse({ fontSize: "xlarge" })).toThrow();
  });

  it("accepts all valid density values", () => {
    for (const density of ["compact", "comfortable", "spacious"] as const) {
      expect(() => Schema.parse({ density })).not.toThrow();
    }
  });

  it("rejects an invalid density enum", () => {
    expect(() => Schema.parse({ density: "normal" })).toThrow();
  });

  it("accepts all valid pendingPromptBehavior values", () => {
    for (const pendingPromptBehavior of ["queue", "interrupt"] as const) {
      expect(() => Schema.parse({ pendingPromptBehavior })).not.toThrow();
    }
  });

  it("rejects an invalid pendingPromptBehavior enum", () => {
    expect(() => Schema.parse({ pendingPromptBehavior: "cancel" })).toThrow();
  });

  it("accepts all valid defaultTextTier values", () => {
    for (const tier of ["fast", "balanced", "precise"] as const) {
      expect(() => Schema.parse({ defaultTextTier: tier })).not.toThrow();
    }
  });

  it("rejects an invalid defaultTextTier enum", () => {
    expect(() => Schema.parse({ defaultTextTier: "premium" })).toThrow();
  });

  it("accepts null for defaultTextTier (nullable — clears the pref)", () => {
    const result = Schema.parse({ defaultTextTier: null });
    expect(result.defaultTextTier).toBeNull();
  });

  it("accepts null for defaultTextModel (nullable — clears)", () => {
    const result = Schema.parse({ defaultTextModel: null });
    expect(result.defaultTextModel).toBeNull();
  });

  it("accepts null for defaultImageModel (nullable — clears)", () => {
    const result = Schema.parse({ defaultImageModel: null });
    expect(result.defaultImageModel).toBeNull();
  });

  it("accepts null for defaultVideoModel (nullable — clears)", () => {
    const result = Schema.parse({ defaultVideoModel: null });
    expect(result.defaultVideoModel).toBeNull();
  });

  it("rejects an empty string for defaultTextModel (min 1)", () => {
    // nullable-optional: null is OK, but empty string is not (z.string().min(1))
    expect(() => Schema.parse({ defaultTextModel: "" })).toThrow();
  });

  it("rejects an empty string for defaultImageModel (min 1)", () => {
    expect(() => Schema.parse({ defaultImageModel: "" })).toThrow();
  });

  it("rejects an empty string for defaultVideoModel (min 1)", () => {
    expect(() => Schema.parse({ defaultVideoModel: "" })).toThrow();
  });

  it("accepts a valid model id string for defaultTextModel", () => {
    const result = Schema.parse({
      defaultTextModel: "anthropic/claude-opus-4.8",
    });
    expect(result.defaultTextModel).toBe("anthropic/claude-opus-4.8");
  });

  it("accepts a boolean for enterToSubmit", () => {
    expect(() => Schema.parse({ enterToSubmit: true })).not.toThrow();
    expect(() => Schema.parse({ enterToSubmit: false })).not.toThrow();
  });

  it("accepts a fully-specified valid payload", () => {
    const result = Schema.parse({
      fontSize: "small",
      density: "compact",
      enterToSubmit: true,
      pendingPromptBehavior: "queue",
      defaultTextTier: "fast",
      defaultTextModel: "anthropic/claude-haiku-3",
      defaultImageModel: "bfl/flux-2-max",
      defaultVideoModel: "google/veo-3.0-generate-001",
    });
    expect(result.fontSize).toBe("small");
    expect(result.defaultTextTier).toBe("fast");
  });
});

// ── workspace.model.settings.write ───────────────────────────────────────────

import { schema as workspaceModelSettingsWriteSchema } from "./workspace.model_settings.write";

describe("workspace.model.settings.write schema", () => {
  const Schema = obj(workspaceModelSettingsWriteSchema);

  it("accepts an empty payload (all fields optional)", () => {
    expect(() => Schema.parse({})).not.toThrow();
  });

  it("accepts all valid defaultTextTier values", () => {
    for (const tier of ["fast", "balanced", "precise"] as const) {
      expect(() => Schema.parse({ defaultTextTier: tier })).not.toThrow();
    }
  });

  it("rejects an invalid defaultTextTier enum", () => {
    expect(() => Schema.parse({ defaultTextTier: "economy" })).toThrow();
  });

  it("accepts null for defaultTextTier (nullable — clears the setting)", () => {
    const result = Schema.parse({ defaultTextTier: null });
    expect(result.defaultTextTier).toBeNull();
  });

  it("accepts null for defaultTextModel (nullable — clears)", () => {
    const result = Schema.parse({ defaultTextModel: null });
    expect(result.defaultTextModel).toBeNull();
  });

  it("accepts null for defaultImageModel (nullable — clears)", () => {
    const result = Schema.parse({ defaultImageModel: null });
    expect(result.defaultImageModel).toBeNull();
  });

  it("accepts null for defaultVideoModel (nullable — clears)", () => {
    const result = Schema.parse({ defaultVideoModel: null });
    expect(result.defaultVideoModel).toBeNull();
  });

  it("rejects an empty string for defaultTextModel (min 1)", () => {
    expect(() => Schema.parse({ defaultTextModel: "" })).toThrow();
  });

  it("rejects an empty string for defaultImageModel (min 1)", () => {
    expect(() => Schema.parse({ defaultImageModel: "" })).toThrow();
  });

  it("rejects an empty string for defaultVideoModel (min 1)", () => {
    expect(() => Schema.parse({ defaultVideoModel: "" })).toThrow();
  });

  it("accepts a valid model id string for defaultImageModel", () => {
    const result = Schema.parse({ defaultImageModel: "bfl/flux-2-max" });
    expect(result.defaultImageModel).toBe("bfl/flux-2-max");
  });

  it("accepts a fully-specified valid payload", () => {
    const result = Schema.parse({
      defaultTextTier: "balanced",
      defaultTextModel: "anthropic/claude-sonnet-5",
      defaultImageModel: "bfl/flux-2-max",
      defaultVideoModel: "google/veo-3.0-generate-001",
    });
    expect(result.defaultTextTier).toBe("balanced");
    expect(result.defaultVideoModel).toBe("google/veo-3.0-generate-001");
  });
});
