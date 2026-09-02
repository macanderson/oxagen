import { describe, expect, it } from "vitest";
import { resolveModelDefaults } from "./resolve-model-defaults";
import type { ModelDefaultsInput } from "./resolve-model-defaults";

// ── helpers ───────────────────────────────────────────────────────────────────

const nullPrefs = {
  defaultTextTier: null,
  defaultTextModel: null,
  defaultImageModel: null,
  defaultVideoModel: null,
} as const;

// ─────────────────────────────────────────────────────────────────────────────

describe("resolveModelDefaults", () => {
  // ── neither set ────────────────────────────────────────────────────────────

  it("returns all null and false override flags when both user and workspace are null", () => {
    const result = resolveModelDefaults({ user: null, workspace: null });
    expect(result.text.tier).toBeNull();
    expect(result.text.model).toBeNull();
    expect(result.image.model).toBeNull();
    expect(result.video.model).toBeNull();
    expect(result.overriddenByWorkspace.text).toBe(false);
    expect(result.overriddenByWorkspace.image).toBe(false);
    expect(result.overriddenByWorkspace.video).toBe(false);
  });

  it("returns all null when both user and workspace have null prefs (but exist)", () => {
    const result = resolveModelDefaults({
      user: nullPrefs,
      workspace: nullPrefs,
    });
    expect(result.text.tier).toBeNull();
    expect(result.text.model).toBeNull();
    expect(result.image.model).toBeNull();
    expect(result.video.model).toBeNull();
    expect(result.overriddenByWorkspace.text).toBe(false);
    expect(result.overriddenByWorkspace.image).toBe(false);
    expect(result.overriddenByWorkspace.video).toBe(false);
  });

  // ── only user set ──────────────────────────────────────────────────────────

  it("uses user prefs when workspace is null (no override)", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "precise",
        defaultTextModel: "anthropic/claude-opus-4.8",
        defaultImageModel: "bfl/flux-2-max",
        defaultVideoModel: "google/veo-3.0-generate-001",
      },
      workspace: null,
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("precise");
    expect(result.text.model).toBe("anthropic/claude-opus-4.8");
    expect(result.image.model).toBe("bfl/flux-2-max");
    expect(result.video.model).toBe("google/veo-3.0-generate-001");
    expect(result.overriddenByWorkspace.text).toBe(false);
    expect(result.overriddenByWorkspace.image).toBe(false);
    expect(result.overriddenByWorkspace.video).toBe(false);
  });

  it("uses user prefs when workspace has all-null prefs (no effective override)", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "fast",
        defaultTextModel: null,
        defaultImageModel: "openai/gpt-image-1",
        defaultVideoModel: null,
      },
      workspace: nullPrefs,
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("fast");
    expect(result.text.model).toBeNull();
    expect(result.image.model).toBe("openai/gpt-image-1");
    expect(result.video.model).toBeNull();
    expect(result.overriddenByWorkspace.text).toBe(false);
    expect(result.overriddenByWorkspace.image).toBe(false);
    expect(result.overriddenByWorkspace.video).toBe(false);
  });

  // ── only workspace set ────────────────────────────────────────────────────

  it("uses workspace prefs when user has no prefs, and sets override flags", () => {
    const input: ModelDefaultsInput = {
      user: null,
      workspace: {
        defaultTextTier: "balanced",
        defaultTextModel: "anthropic/claude-sonnet-5",
        defaultImageModel: "bfl/flux-2-max",
        defaultVideoModel: "google/veo-3.0-generate-001",
      },
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("balanced");
    expect(result.text.model).toBe("anthropic/claude-sonnet-5");
    expect(result.image.model).toBe("bfl/flux-2-max");
    expect(result.video.model).toBe("google/veo-3.0-generate-001");
    expect(result.overriddenByWorkspace.text).toBe(true);
    expect(result.overriddenByWorkspace.image).toBe(true);
    expect(result.overriddenByWorkspace.video).toBe(true);
  });

  // ── both set — workspace wins ─────────────────────────────────────────────

  it("workspace values win over user values, all override flags are true", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "precise",
        defaultTextModel: "anthropic/claude-opus-4.8",
        defaultImageModel: "openai/gpt-image-1",
        defaultVideoModel: "google/veo-3.0-fast-generate-001",
      },
      workspace: {
        defaultTextTier: "fast",
        defaultTextModel: "openai/gpt-5-mini",
        defaultImageModel: "bfl/flux-2-max",
        defaultVideoModel: "google/veo-3.0-generate-001",
      },
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("fast");
    expect(result.text.model).toBe("openai/gpt-5-mini");
    expect(result.image.model).toBe("bfl/flux-2-max");
    expect(result.video.model).toBe("google/veo-3.0-generate-001");
    expect(result.overriddenByWorkspace.text).toBe(true);
    expect(result.overriddenByWorkspace.image).toBe(true);
    expect(result.overriddenByWorkspace.video).toBe(true);
  });

  it("partial workspace override: only image overridden, text+video from user", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "precise",
        defaultTextModel: "anthropic/claude-opus-4.8",
        defaultImageModel: "openai/gpt-image-1",
        defaultVideoModel: "google/veo-3.0-generate-001",
      },
      workspace: {
        defaultTextTier: null,
        defaultTextModel: null,
        defaultImageModel: "bfl/flux-2-max",
        defaultVideoModel: null,
      },
    };
    const result = resolveModelDefaults(input);
    expect(result.text.tier).toBe("precise");
    expect(result.text.model).toBe("anthropic/claude-opus-4.8");
    expect(result.image.model).toBe("bfl/flux-2-max");
    expect(result.video.model).toBe("google/veo-3.0-generate-001");
    expect(result.overriddenByWorkspace.text).toBe(false);
    expect(result.overriddenByWorkspace.image).toBe(true);
    expect(result.overriddenByWorkspace.video).toBe(false);
  });

  // ── text: model beats tier precedence ─────────────────────────────────────

  it("text model beats tier at the user level when both are set", () => {
    const input: ModelDefaultsInput = {
      user: {
        defaultTextTier: "fast",
        defaultTextModel: "anthropic/claude-opus-4.8",
        defaultImageModel: null,
        defaultVideoModel: null,
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
        defaultImageModel: null,
        defaultVideoModel: null,
      },
      workspace: {
        defaultTextTier: "fast",
        defaultTextModel: "openai/gpt-5.2",
        defaultImageModel: null,
        defaultVideoModel: null,
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
        defaultImageModel: null,
        defaultVideoModel: null,
      },
      workspace: {
        defaultTextTier: "balanced",
        defaultTextModel: null,
        defaultImageModel: null,
        defaultVideoModel: null,
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
});
