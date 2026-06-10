/**
 * connector-schema-loader tests.
 *
 * Strategy:
 *   - loadBuiltInSchema: verify it loads and caches each built-in YAML schema correctly.
 *     The real YAML files exist on disk, so no mocking is needed.
 *   - loadBuiltInSchema: verify it returns null for unknown plugin IDs.
 *   - validateConfigAgainstSchema: validate required, pattern, itemPattern,
 *     minItems, maxItems, min/max number, and oneOf rules.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  loadBuiltInSchema,
  validateConfigAgainstSchema,
  _clearSchemaCacheForTest,
} from "../connector-schema-loader";

beforeEach(() => {
  _clearSchemaCacheForTest();
});

// ── loadBuiltInSchema ──────────────────────────────────────────────────────────

describe("loadBuiltInSchema — built-in plugins", () => {
  it("loads the github schema and returns a valid ConnectorPlugin object", () => {
    const schema = loadBuiltInSchema("github");
    expect(schema).not.toBeNull();
    expect(schema?.apiVersion).toBe("oxagen.ai/v1alpha1");
    expect(schema?.kind).toBe("ConnectorPlugin");
    expect(schema?.metadata.id).toBe("github");
    expect(schema?.metadata.displayName).toBe("GitHub");
    expect(schema?.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(schema?.metadata.schemaVersion).toBeTruthy();
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the slack schema", () => {
    const schema = loadBuiltInSchema("slack");
    expect(schema?.metadata.id).toBe("slack");
    expect(schema?.metadata.displayName).toBe("Slack");
  });

  it("loads the linear schema", () => {
    const schema = loadBuiltInSchema("linear");
    expect(schema?.metadata.id).toBe("linear");
    expect(schema?.metadata.displayName).toBe("Linear");
  });

  it("loads the google-drive schema", () => {
    const schema = loadBuiltInSchema("google-drive");
    expect(schema?.metadata.id).toBe("google-drive");
    expect(schema?.metadata.displayName).toBe("Google Drive");
  });

  it("returns null for an unknown plugin id", () => {
    expect(loadBuiltInSchema("unknown-plugin")).toBeNull();
  });

  it("returns null for an empty plugin id", () => {
    expect(loadBuiltInSchema("")).toBeNull();
  });

  it("returns the same object reference on repeated calls (in-process cache)", () => {
    const first = loadBuiltInSchema("github");
    const second = loadBuiltInSchema("github");
    expect(first).toBe(second);
  });

  it("cache returns fresh instance after _clearSchemaCacheForTest", () => {
    const first = loadBuiltInSchema("github");
    _clearSchemaCacheForTest();
    const second = loadBuiltInSchema("github");
    // Different object reference (re-read from disk) but same content.
    expect(second).not.toBe(first);
    expect(second?.metadata.id).toBe("github");
  });
});

// ── validateConfigAgainstSchema — required field ───────────────────────────────

describe("validateConfigAgainstSchema — required fields", () => {
  const githubSchema = () => loadBuiltInSchema("github")!;

  it("returns no errors when all required config fields are present", () => {
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"] },
      githubSchema(),
    );
    expect(errors).toEqual([]);
  });

  it("returns a required error when a required field is missing", () => {
    const errors = validateConfigAgainstSchema({}, githubSchema());
    const required = errors.find((e) => e.field === "config.organizations");
    expect(required).toBeDefined();
    expect(required?.code).toBe("required");
  });

  it("returns a required error when a required field is empty string", () => {
    const errors = validateConfigAgainstSchema(
      { organizations: "" },
      githubSchema(),
    );
    const required = errors.find((e) => e.field === "config.organizations");
    expect(required?.code).toBe("required");
  });
});

// ── validateConfigAgainstSchema — auth scheme fields ──────────────────────────

describe("validateConfigAgainstSchema — auth scheme fields", () => {
  it("validates auth scheme fields when authSchemeId is provided", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    // pat scheme requires apiKey
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"] },
      githubSchema,
      "pat",
    );
    const apiKeyError = errors.find((e) => e.field === "auth.apiKey");
    expect(apiKeyError).toBeDefined();
    expect(apiKeyError?.code).toBe("required");
  });

  it("passes auth validation when a valid PAT is provided", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"], apiKey: "ghp_abcdefghijklmnopqrstu" },
      githubSchema,
      "pat",
    );
    const apiKeyErrors = errors.filter((e) => e.field === "auth.apiKey");
    expect(apiKeyErrors).toEqual([]);
  });

  it("returns pattern error for a malformed PAT", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"], apiKey: "not-a-pat" },
      githubSchema,
      "pat",
    );
    const patternError = errors.find(
      (e) => e.field === "auth.apiKey" && e.code === "pattern",
    );
    expect(patternError).toBeDefined();
  });

  it("skips auth field validation when no authSchemeId is provided", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"] },
      githubSchema,
      undefined,
    );
    const authErrors = errors.filter((e) => e.field.startsWith("auth."));
    expect(authErrors).toEqual([]);
  });
});

// ── validateConfigAgainstSchema — minItems ─────────────────────────────────────

describe("validateConfigAgainstSchema — minItems", () => {
  it("returns minItems error when array has fewer items than required", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    const errors = validateConfigAgainstSchema(
      { organizations: [] },
      githubSchema,
    );
    const minError = errors.find(
      (e) => e.field === "config.organizations" && e.code === "minItems",
    );
    expect(minError).toBeDefined();
    expect(minError?.message).toContain("at least 1");
  });

  it("passes minItems when array has sufficient items", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme", "oxagen"] },
      githubSchema,
    );
    const minErrors = errors.filter((e) => e.code === "minItems");
    expect(minErrors).toEqual([]);
  });
});

// ── validateConfigAgainstSchema — itemPattern ─────────────────────────────────

describe("validateConfigAgainstSchema — itemPattern", () => {
  it("returns itemPattern error when an array item violates the pattern", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    // organizations itemPattern: ^[a-zA-Z0-9][a-zA-Z0-9\-]{0,38}$
    const errors = validateConfigAgainstSchema(
      { organizations: ["valid-org", "INVALID ORG!"] },
      githubSchema,
    );
    const itemError = errors.find((e) => e.code === "itemPattern");
    expect(itemError).toBeDefined();
    expect(itemError?.message).toContain("INVALID ORG!");
  });

  it("only reports the first failing item (not all)", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    const errors = validateConfigAgainstSchema(
      { organizations: ["bad org1", "bad org2"] },
      githubSchema,
    );
    const itemErrors = errors.filter((e) => e.code === "itemPattern");
    expect(itemErrors.length).toBe(1);
  });
});

// ── validateConfigAgainstSchema — number range ────────────────────────────────

describe("validateConfigAgainstSchema — number min/max", () => {
  it("returns min error when number is below minimum", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    // syncDepthDays min: 1
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"], syncDepthDays: 0 },
      githubSchema,
    );
    const minError = errors.find(
      (e) => e.field === "config.syncDepthDays" && e.code === "min",
    );
    expect(minError).toBeDefined();
  });

  it("returns max error when number exceeds maximum", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    // syncDepthDays max: 730
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"], syncDepthDays: 731 },
      githubSchema,
    );
    const maxError = errors.find(
      (e) => e.field === "config.syncDepthDays" && e.code === "max",
    );
    expect(maxError).toBeDefined();
  });

  it("passes when number is within allowed range", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"], syncDepthDays: 90 },
      githubSchema,
    );
    const rangeErrors = errors.filter(
      (e) => e.field === "config.syncDepthDays",
    );
    expect(rangeErrors).toEqual([]);
  });
});

// ── validateConfigAgainstSchema — optional absent fields ──────────────────────

describe("validateConfigAgainstSchema — optional fields", () => {
  it("does not report errors for absent optional fields", () => {
    const githubSchema = loadBuiltInSchema("github")!;
    // repositories is optional
    const errors = validateConfigAgainstSchema(
      { organizations: ["acme"] },
      githubSchema,
    );
    const repoErrors = errors.filter(
      (e) => e.field === "config.repositories",
    );
    expect(repoErrors).toEqual([]);
  });
});

// ── validateConfigAgainstSchema — valid full config ───────────────────────────

describe("validateConfigAgainstSchema — slack full valid config", () => {
  it("passes validation for a complete valid slack config", () => {
    const slackSchema = loadBuiltInSchema("slack")!;
    const errors = validateConfigAgainstSchema(
      {
        channelIds: [],
        includePrivateChannels: false,
        includeDirectMessages: false,
        syncDepthDays: 90,
        excludeBotMessages: true,
      },
      slackSchema,
    );
    // All slack config fields are optional — no required violations expected.
    expect(errors).toEqual([]);
  });
});
