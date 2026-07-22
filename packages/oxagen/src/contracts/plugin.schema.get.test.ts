import { describe, expect, it } from "vitest";
import { pluginSchemaGet } from "./plugin.schema.get";
import { getCapability } from "../registry";

// ── helpers ───────────────────────────────────────────────────────────────────

const minimalValidOutput = {
  apiVersion: "oxagen.ai/v1alpha1" as const,
  kind: "ConnectorPlugin" as const,
  metadata: {
    id: "github",
    displayName: "GitHub",
    version: "1.0.0",
    schemaVersion: "v1",
    publisher: {
      name: "Oxagen",
      verified: true,
    },
  },
};

describe("plugin.schema.get capability", () => {
  // ── input schema ──────────────────────────────────────────────────────────

  it("accepts a valid pluginId string", () => {
    const parsed = pluginSchemaGet.input.parse({ pluginId: "github" });
    expect(parsed.pluginId).toBe("github");
  });

  it("rejects input missing pluginId", () => {
    expect(() => pluginSchemaGet.input.parse({})).toThrow();
  });

  it("rejects non-string pluginId", () => {
    expect(() => pluginSchemaGet.input.parse({ pluginId: 123 })).toThrow();
  });

  // ── output: minimal required fields ──────────────────────────────────────

  it("parses a minimal valid output with required fields only", () => {
    const parsed = pluginSchemaGet.output.parse(minimalValidOutput);
    expect(parsed.apiVersion).toBe("oxagen.ai/v1alpha1");
    expect(parsed.kind).toBe("ConnectorPlugin");
    expect(parsed.metadata.id).toBe("github");
    expect(parsed.metadata.displayName).toBe("GitHub");
    expect(parsed.metadata.publisher.verified).toBe(true);
  });

  it("parses output with optional metadata fields populated", () => {
    const parsed = pluginSchemaGet.output.parse({
      ...minimalValidOutput,
      metadata: {
        ...minimalValidOutput.metadata,
        description: "GitHub connector for repo ingestion",
        icon: "https://cdn.example.com/github.svg",
        category: "version-control",
      },
    });
    expect(parsed.metadata.description).toBe(
      "GitHub connector for repo ingestion",
    );
    expect(parsed.metadata.icon).toBe("https://cdn.example.com/github.svg");
    expect(parsed.metadata.category).toBe("version-control");
  });

  // ── output: apiVersion and kind literals ──────────────────────────────────

  it("rejects an incorrect apiVersion literal", () => {
    expect(() =>
      pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        apiVersion: "oxagen.ai/v2",
      }),
    ).toThrow();
  });

  it("rejects an incorrect kind literal", () => {
    expect(() =>
      pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        kind: "Plugin",
      }),
    ).toThrow();
  });

  // ── output: optional auth section ────────────────────────────────────────

  it("parses output with an auth section using api_key scheme", () => {
    const parsed = pluginSchemaGet.output.parse({
      ...minimalValidOutput,
      auth: {
        schemes: [
          {
            id: "pat",
            kind: "api_key",
            label: "Personal Access Token",
            fields: [
              {
                key: "token",
                label: "Token",
                widget: "secret",
              },
            ],
          },
        ],
      },
    });
    expect(parsed.auth?.schemes).toHaveLength(1);
    expect(parsed.auth?.schemes[0]?.kind).toBe("api_key");
  });

  it("accepts all valid auth scheme kinds", () => {
    const kinds = [
      "oauth2_authorization_code",
      "oauth2_client_credentials",
      "api_key",
      "basic",
      "none",
    ] as const;
    for (const kind of kinds) {
      const parsed = pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        auth: { schemes: [{ id: "s1", kind }] },
      });
      expect(parsed.auth?.schemes[0]?.kind).toBe(kind);
    }
  });

  it("rejects an unknown auth scheme kind", () => {
    expect(() =>
      pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        auth: { schemes: [{ id: "s1", kind: "saml" }] },
      }),
    ).toThrow();
  });

  // ── output: optional config section ──────────────────────────────────────

  it("parses output with a config section", () => {
    const parsed = pluginSchemaGet.output.parse({
      ...minimalValidOutput,
      config: {
        fields: [
          {
            key: "organizations",
            label: "Organizations",
            widget: "tag-input",
            description: "GitHub organizations to sync",
          },
        ],
      },
    });
    expect(parsed.config?.fields).toHaveLength(1);
    expect(parsed.config?.fields[0]?.widget).toBe("tag-input");
  });

  it("accepts all valid widget types", () => {
    const widgets = [
      "text",
      "email",
      "url",
      "secret",
      "number",
      "textarea",
      // Regression: custom-sql / custom-webhook / google-bigquery ship
      // `widget: code`; omitting it from the enum failed get_plugin_schema
      // OUTPUT validation (invalid_output → 500) for those connectors.
      "code",
      "select",
      "multi-select",
      "tag-input",
      "checkbox",
      "slider",
      "key-value",
      "secret-file",
    ] as const;
    for (const widget of widgets) {
      const parsed = pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        config: {
          fields: [{ key: "f", label: "F", widget }],
        },
      });
      expect(parsed.config?.fields[0]?.widget).toBe(widget);
    }
  });

  it("rejects an unknown widget type", () => {
    expect(() =>
      pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        config: {
          fields: [{ key: "f", label: "F", widget: "date-picker" }],
        },
      }),
    ).toThrow();
  });

  // ── output: optional recordTypes section ─────────────────────────────────

  it("parses output with a recordTypes section", () => {
    const parsed = pluginSchemaGet.output.parse({
      ...minimalValidOutput,
      recordTypes: {
        selectionMode: "multi",
        defaultAll: true,
        items: [
          {
            id: "pull_request",
            displayName: "Pull Requests",
            defaultEnabled: true,
          },
        ],
      },
    });
    expect(parsed.recordTypes?.selectionMode).toBe("multi");
    expect(parsed.recordTypes?.items).toHaveLength(1);
  });

  it("rejects invalid selectionMode", () => {
    expect(() =>
      pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        recordTypes: {
          selectionMode: "all",
          items: [],
        },
      }),
    ).toThrow();
  });

  it("does not expose legacy connector inference configuration", () => {
    const parsed = pluginSchemaGet.output.parse({
      ...minimalValidOutput,
      inference: {
        enabled: true,
      },
    });

    expect(parsed).not.toHaveProperty("inference");
  });

  // ── output: optional sync section ────────────────────────────────────────

  it("parses output with a sync section using polling delivery", () => {
    const parsed = pluginSchemaGet.output.parse({
      ...minimalValidOutput,
      sync: {
        delivery: "polling",
        pollingSupported: true,
        polling: {
          defaultIntervalSeconds: 300,
          minIntervalSeconds: 60,
        },
      },
    });
    expect(parsed.sync?.delivery).toBe("polling");
    expect(parsed.sync?.polling?.defaultIntervalSeconds).toBe(300);
  });

  it("accepts all valid sync delivery values", () => {
    const deliveries = ["webhook", "polling", "manual"] as const;
    for (const delivery of deliveries) {
      const parsed = pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        sync: { delivery },
      });
      expect(parsed.sync?.delivery).toBe(delivery);
    }
  });

  it("rejects an unknown sync delivery value", () => {
    expect(() =>
      pluginSchemaGet.output.parse({
        ...minimalValidOutput,
        sync: { delivery: "push" },
      }),
    ).toThrow();
  });

  // ── output: invalid top-level ─────────────────────────────────────────────

  it("rejects output missing metadata", () => {
    expect(() =>
      pluginSchemaGet.output.parse({
        apiVersion: "oxagen.ai/v1alpha1",
        kind: "ConnectorPlugin",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_plugin_schema")).toBe(pluginSchemaGet);
  });
});
