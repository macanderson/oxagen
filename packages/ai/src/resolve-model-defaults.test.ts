import { describe, expect, it } from "vitest";
import { resolveModelDefaults } from "./resolve-model-defaults";
import type { ModelDefaultsInput } from "./resolve-model-defaults";

// ── helpers ───────────────────────────────────────────────────────────────────

const nullPrefs = {
  defaultTextTier: null,
  defaultTextModel: null,
} as const;

// ─────────────────────────────────────────────────────────────────────────────

describe("resolveModelDefaults", () => {
  // ── neither set ────────────────────────────────────────────────────────────

  it("returns all null and false override flags when both user and workspace are null", () => {
    const result = resolveModelDefaults({ user: null, workspace: null });
    expect(result.text.tier).toBeNull();
    expect(result.text.model).toBeNull();
    expect(result.overriddenByWorkspace.text).toBe(false);
  });

  it("returns all null when both user and workspace have null prefs (but exist)", () => {
    const result = resolveModelDefaults({
      user: nullPrefs,
      workspace: nullPrefs,
    });
    expect(result.text.tier).toBeNull();
    expect(result.text.model).toBeNull();
    expect(result.overriddenByWorkspace.text).toBe(false);
  });

  // ── only user set ──────────────────────────────────────────────────────────

  it("uses user prefs when workspace is null (no override)", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "precise",
        defaultTextModel: "anthropic/claude-opus-4.8",
      },
      workspace: null,
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("precise");
    expect(result.text.model).toBe("anthropic/claude-opus-4.8");
    expect(result.overriddenByWorkspace.text).toBe(false);
  });

  it("uses user prefs when workspace has all-null prefs (no effective override)", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "fast",
        defaultTextModel: null,
      },
      workspace: nullPrefs,
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("fast");
    expect(result.text.model).toBeNull();
    expect(result.overriddenByWorkspace.text).toBe(false);
  });

  // ── only workspace set ────────────────────────────────────────────────────

  it("uses workspace prefs when user has no prefs, and sets the override flag", () => {
    const input: ModelDefaultsInput = {
      user: null,
      workspace: {
        defaultTextTier: "balanced",
        defaultTextModel: "anthropic/claude-sonnet-5",
      },
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("balanced");
    expect(result.text.model).toBe("anthropic/claude-sonnet-5");
    expect(result.overriddenByWorkspace.text).toBe(true);
  });

  // ── both set — workspace wins ─────────────────────────────────────────────

  it("workspace values win over user values, the override flag is true", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "precise",
        defaultTextModel: "anthropic/claude-opus-4.8",
      },
      workspace: {
        defaultTextTier: "fast",
        defaultTextModel: "openai/gpt-5-mini",
      },
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("fast");
    expect(result.text.model).toBe("openai/gpt-5-mini");
    expect(result.overriddenByWorkspace.text).toBe(true);
  });

  // ── text: model beats tier precedence ─────────────────────────────────────

  it("text model beats tier at the user level when both are set", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "fast",
        defaultTextModel: "anthropic/claude-opus-4.8",
      },
      workspace: null,
    };
    const result = resolveModelDefaults(input);
    // Both tier and model are returned; the consumer decides which to use.
    // When model is set, the consumer should prefer it over tier.
    expect(result.text.tier).toBe("fast");
    expect(result.text.model).toBe("anthropic/claude-opus-4.8");
    // Model is non-null so a smart consumer uses it, ignoring the tier.
    // (The resolver exposes both; tier is still surfaced for UI labels.)
  });

  it("workspace model beats workspace tier (model takes precedence at workspace level)", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "precise",
        defaultTextModel: null,
      },
      workspace: {
        defaultTextTier: "fast",
        defaultTextModel: "openai/gpt-5.2",
      },
    };
    const result = resolveModelDefaults(input);
    // workspace.model wins over workspace.tier and user.*
    expect(result.text.model).toBe("openai/gpt-5.2");
    expect(result.text.tier).toBe("fast");
    expect(result.overriddenByWorkspace.text).toBe(true);
  });

  it("workspace tier overrides user model when workspace has no explicit model", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: null,
        defaultTextModel: "anthropic/claude-opus-4.8",
      },
      workspace: {
        defaultTextTier: "balanced",
        defaultTextModel: null,
      },
    };
    const result = resolveModelDefaults(input);
    // workspace.model is null → falls back to user.model
    expect(result.text.model).toBe("anthropic/claude-opus-4.8");
    // workspace.tier is set → overrides user.tier (null)
    expect(result.text.tier).toBe("balanced");
    // workspace has a tier set → text is overridden
    expect(result.overriddenByWorkspace.text).toBe(true);
  });

  // ── ADR-043: media generation, and its stored defaults, are gone ───────────

  it("resolves text as the only dimension — no image or video model", () => {
    const result = resolveModelDefaults({
      user: { defaultTextTier: "fast", defaultTextModel: null },
      workspace: null,
    });
    expect(result).not.toHaveProperty("image");
    expect(result).not.toHaveProperty("video");
    expect(Object.keys(result).sort()).toEqual([
      "overriddenByWorkspace",
      "text",
    ]);
    expect(Object.keys(result.overriddenByWorkspace)).toEqual(["text"]);
  });
});
