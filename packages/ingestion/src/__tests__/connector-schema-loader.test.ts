/**
 * connector-schema-loader tests.
 *
 * Strategy:
 *   - loadBuiltInSchema: verify it loads and caches each built-in YAML schema correctly.
 *     The real YAML files exist on disk, so no mocking is needed.
 *   - loadBuiltInSchema: verify it returns null for unknown plugin IDs.
 *   - loadSchema: verify built-in resolution path (no schemaUrl needed).
 *   - loadSchema: verify partner URL fetch path with a mocked fetch injected via
 *     globalThis.fetch override — validates caching, retry behaviour on 5xx,
 *     immediate failure on 4xx, shape validation, and cacheWriter callback.
 *   - validateConfigAgainstSchema: validate required, pattern, itemPattern,
 *     minItems, maxItems, min/max number, and oneOf rules.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILT_IN_PLUGIN_IDS,
  loadBuiltInSchema,
  loadSchema,
  validateConfigAgainstSchema,
  _clearSchemaCacheForTest,
} from "../connector-schema-loader";

// ── Shared partner schema YAML fixture ────────────────────────────────────────

const PARTNER_SCHEMA_YAML = `
apiVersion: oxagen.ai/v1alpha1
kind: ConnectorPlugin
metadata:
  id: custom-partner
  displayName: Custom Partner
  version: "1.0.0"
  schemaVersion: "1"
  publisher:
    name: Acme Corp
    verified: false
auth:
  schemes:
    - id: api_key
      kind: api_key
      displayName: API Key
      fields:
        - key: apiKey
          label: API Key
          widget: secret
          validation:
            required: true
config:
  fields:
    - key: accountId
      label: Account ID
      widget: text
      validation:
        required: true
sync:
  delivery: polling
  pollingSupported: true
  polling:
    defaultIntervalSeconds: 600
    minIntervalSeconds: 300
    maxIntervalSeconds: 86400
`;

/** Build a minimal Response-compatible mock. */
function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  _clearSchemaCacheForTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    const recordTypes = schema?.["recordTypes"] as {
      items: Array<{ id: string }>;
    };
    const filters = schema?.["filters"] as Record<string, unknown>;
    expect(recordTypes.items.map((item) => item.id)).not.toContain("source");
    expect(filters["pathFilters"]).toBeUndefined();
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

  // ── Additional built-in connector schemas ─────────────────────────────────

  it("loads the google-calendar schema", () => {
    const schema = loadBuiltInSchema("google-calendar");
    expect(schema?.metadata.id).toBe("google-calendar");
    expect(schema?.metadata.displayName).toBe("Google Calendar");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the google-gmail schema", () => {
    const schema = loadBuiltInSchema("google-gmail");
    expect(schema?.metadata.id).toBe("google-gmail");
    expect(schema?.metadata.displayName).toBe("Gmail");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the google-meet schema", () => {
    const schema = loadBuiltInSchema("google-meet");
    expect(schema?.metadata.id).toBe("google-meet");
    expect(schema?.metadata.displayName).toBe("Google Meet");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the google-tasks schema", () => {
    const schema = loadBuiltInSchema("google-tasks");
    expect(schema?.metadata.id).toBe("google-tasks");
    expect(schema?.metadata.displayName).toBe("Google Tasks");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the google-contacts schema", () => {
    const schema = loadBuiltInSchema("google-contacts");
    expect(schema?.metadata.id).toBe("google-contacts");
    expect(schema?.metadata.displayName).toBe("Google Contacts");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the google-bigquery schema", () => {
    const schema = loadBuiltInSchema("google-bigquery");
    expect(schema?.metadata.id).toBe("google-bigquery");
    expect(schema?.metadata.displayName).toBe("Google BigQuery");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the microsoft schema", () => {
    const schema = loadBuiltInSchema("microsoft");
    expect(schema?.metadata.id).toBe("microsoft");
    expect(schema?.metadata.displayName).toBe("Microsoft 365");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the salesforce schema", () => {
    const schema = loadBuiltInSchema("salesforce");
    expect(schema?.metadata.id).toBe("salesforce");
    expect(schema?.metadata.displayName).toBe("Salesforce");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the zoom schema", () => {
    const schema = loadBuiltInSchema("zoom");
    expect(schema?.metadata.id).toBe("zoom");
    expect(schema?.metadata.displayName).toBe("Zoom");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the custom-sql schema", () => {
    const schema = loadBuiltInSchema("custom-sql");
    expect(schema?.metadata.id).toBe("custom-sql");
    expect(schema?.metadata.displayName).toBe("Custom SQL");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the custom-webhook schema", () => {
    const schema = loadBuiltInSchema("custom-webhook");
    expect(schema?.metadata.id).toBe("custom-webhook");
    expect(schema?.metadata.displayName).toBe("Generic Webhook");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("loads the example-saas schema (reference connector)", () => {
    const schema = loadBuiltInSchema("example-saas");
    expect(schema?.metadata.id).toBe("example-saas");
    expect(schema?.metadata.displayName).toBe("ExampleSaaS");
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  // Regression: set size must match the number of schema.yaml files on disk,
  // so this test catches drift in either direction.
  it("BUILT_IN_PLUGIN_IDS contains the expected 18 connector ids", () => {
    // Update this count whenever a new connector is added to BUILT_IN_PLUGIN_IDS.
    // Current set: github, linear, slack, google-drive, google-calendar, google-gmail,
    // google-meet, google-tasks, google-contacts, google-bigquery, microsoft, salesforce,
    // zoom, stripe, zendesk, custom-sql, custom-webhook, example-saas = 18.
    expect(BUILT_IN_PLUGIN_IDS.size).toBe(18);
  });

  // Regression: every declared built-in MUST have a schema file that resolves
  // on disk and loads. In prod, apps/api esbuild-bundles this loader (CJS) and
  // copies these YAMLs next to the function; a built-in id without a matching
  // file — or a loader that can't find it — 500s the connector "Configure" flow.
  it("loads every declared built-in plugin id without throwing", () => {
    for (const id of BUILT_IN_PLUGIN_IDS) {
      const schema = loadBuiltInSchema(id);
      expect(schema, `built-in "${id}" should load`).not.toBeNull();
      expect(schema?.metadata.id).toBe(id);
      expect(schema?.apiVersion).toBe("oxagen.ai/v1alpha1");
      expect(schema?.kind).toBe("ConnectorPlugin");
      expect(schema).not.toHaveProperty("inference");
    }
  });

  it("resolves each built-in schema file from the loader module directory", () => {
    // Mirror the loader's primary resolution path (moduleDir() → connectors/<id>).
    // The bundle copy in apps/api/build.mjs relies on this exact layout, so a
    // drift here would break prod even while dev/vitest pass via the fallback.
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const connectorsDir = resolve(moduleDir, "..", "connectors");
    for (const id of BUILT_IN_PLUGIN_IDS) {
      expect(
        existsSync(resolve(connectorsDir, id, "schema.yaml")),
        `connectors/${id}/schema.yaml must exist`,
      ).toBe(true);
    }
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

// ── loadSchema — built-in resolution path ─────────────────────────────────────

describe("loadSchema — built-in connectors (no schemaUrl needed)", () => {
  it("resolves 'github' as a built-in without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const schema = await loadSchema("github");
    expect(schema).not.toBeNull();
    expect(schema?.metadata.id).toBe("github");
    // fetch must not be called for built-in schemas.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null for unknown plugin with no schemaUrl", async () => {
    const result = await loadSchema("nonexistent-plugin");
    expect(result).toBeNull();
  });

  it("ignores schemaUrl when pluginId is a known built-in", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const schema = await loadSchema("slack", {
      schemaUrl: "https://example.com/schema.yaml",
    });
    expect(schema?.metadata.id).toBe("slack");
    // Built-in wins — URL should not be fetched.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── loadSchema — partner URL fetch path ───────────────────────────────────────

describe("loadSchema — partner URL fetch", () => {
  it("fetches and parses a partner schema from schemaUrl", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(PARTNER_SCHEMA_YAML),
    );

    const schema = await loadSchema("custom-partner", {
      schemaUrl: "https://cdn.example.com/schema.yaml",
    });

    expect(schema).not.toBeNull();
    expect(schema?.apiVersion).toBe("oxagen.ai/v1alpha1");
    expect(schema?.kind).toBe("ConnectorPlugin");
    expect(schema?.metadata.id).toBe("custom-partner");
    expect(schema?.metadata.displayName).toBe("Custom Partner");
  });

  it("calls cacheWriter with pluginId, schemaUrl, and parsed schema", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(PARTNER_SCHEMA_YAML),
    );

    const cacheWriter = vi.fn().mockResolvedValue(undefined);

    await loadSchema("custom-partner", {
      schemaUrl: "https://cdn.example.com/schema.yaml",
      cacheWriter,
    });

    expect(cacheWriter).toHaveBeenCalledOnce();
    expect(cacheWriter).toHaveBeenCalledWith(
      "custom-partner",
      "https://cdn.example.com/schema.yaml",
      expect.objectContaining({
        metadata: expect.objectContaining({ id: "custom-partner" }),
      }),
    );
  });

  it("returns cached instance on repeated calls without re-fetching", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeResponse(PARTNER_SCHEMA_YAML));

    const first = await loadSchema("custom-partner", {
      schemaUrl: "https://cdn.example.com/schema.yaml",
    });
    const second = await loadSchema("custom-partner", {
      schemaUrl: "https://cdn.example.com/schema.yaml",
    });

    expect(first).toBe(second);
    // fetch called exactly once — second call hits the in-process cache.
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not call cacheWriter on cache hit (second call)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(PARTNER_SCHEMA_YAML),
    );

    const cacheWriter = vi.fn().mockResolvedValue(undefined);
    const opts = {
      schemaUrl: "https://cdn.example.com/schema.yaml",
      cacheWriter,
    };

    await loadSchema("custom-partner", opts);
    await loadSchema("custom-partner", opts);

    // cacheWriter called exactly once (on initial fetch, not on cache hit).
    expect(cacheWriter).toHaveBeenCalledOnce();
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeResponse("", 503))
      .mockResolvedValueOnce(makeResponse(PARTNER_SCHEMA_YAML));

    const schema = await loadSchema("custom-partner", {
      schemaUrl: "https://cdn.example.com/schema.yaml",
      maxRetries: 2,
    });

    expect(schema?.metadata.id).toBe("custom-partner");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on 4xx (non-retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse("Not Found", 404),
    );

    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://cdn.example.com/schema.yaml",
        maxRetries: 2,
      }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws after exhausting all retries on repeated 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeResponse("", 500));

    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://cdn.example.com/schema.yaml",
        maxRetries: 1,
      }),
    ).rejects.toThrow(/returned 500/);
  });

  it("throws on empty response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse("   "));

    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://cdn.example.com/schema.yaml",
      }),
    ).rejects.toThrow(/empty response/);
  });

  it("throws when fetched YAML has wrong apiVersion", async () => {
    const badSchema = PARTNER_SCHEMA_YAML.replace(
      "oxagen.ai/v1alpha1",
      "oxagen.ai/v2",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(badSchema),
    );

    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://cdn.example.com/schema.yaml",
      }),
    ).rejects.toThrow(/unsupported apiVersion/);
  });

  it("throws when fetched YAML has wrong kind", async () => {
    const badSchema = PARTNER_SCHEMA_YAML.replace(
      "kind: ConnectorPlugin",
      "kind: SomethingElse",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(badSchema),
    );

    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://cdn.example.com/schema.yaml",
      }),
    ).rejects.toThrow(/unexpected kind/);
  });

  it("throws when fetched YAML is missing metadata.id", async () => {
    const badSchema = `
apiVersion: oxagen.ai/v1alpha1
kind: ConnectorPlugin
metadata:
  displayName: No ID
  version: "1.0.0"
  schemaVersion: "1"
  publisher:
    name: Test
    verified: false
sync:
  delivery: polling
`;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(badSchema),
    );

    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://cdn.example.com/schema.yaml",
      }),
    ).rejects.toThrow(/missing metadata\.id/);
  });
});

// ── loadSchema — SSRF guard (scheme + private-host blocking) ──────────────────

describe("loadSchema — SSRF protection on partner schemaUrl", () => {
  beforeEach(() => {
    _clearSchemaCacheForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a non-HTTPS schemaUrl without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "http://cdn.example.com/schema.yaml",
      }),
    ).rejects.toThrow(/must use HTTPS/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects the cloud metadata IP (169.254.169.254) without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://169.254.169.254/latest/meta-data/",
      }),
    ).rejects.toThrow(/non-public address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a loopback IP literal without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://127.0.0.1/schema.yaml",
      }),
    ).rejects.toThrow(/non-public address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an RFC1918 private IP literal without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://10.0.0.5/schema.yaml",
      }),
    ).rejects.toThrow(/non-public address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects localhost without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      loadSchema("custom-partner", {
        schemaUrl: "https://localhost/schema.yaml",
      }),
    ).rejects.toThrow(/not a permitted public host/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── loadSchema — integration: cache cleared between tests ─────────────────────

describe("loadSchema — after cache clear, re-fetches partner schema", () => {
  it("fetches again after _clearSchemaCacheForTest", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse(PARTNER_SCHEMA_YAML));

    await loadSchema("custom-partner", {
      schemaUrl: "https://cdn.example.com/schema.yaml",
    });
    _clearSchemaCacheForTest();
    await loadSchema("custom-partner", {
      schemaUrl: "https://cdn.example.com/schema.yaml",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
    const repoErrors = errors.filter((e) => e.field === "config.repositories");
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
