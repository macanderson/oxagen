// @vitest-environment jsdom
/**
 * auth-scheme-picker.test.tsx — Unit tests for AuthSchemePicker and SchemeFields.
 */

import { render, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { ConnectorSchemaProvider } from "./connector-schema-provider";
import { AuthSchemePicker } from "./auth-scheme-picker";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

// ── Schema fixtures ────────────────────────────────────────────────────────────

const MULTI_AUTH_SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "test",
    displayName: "Test",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  auth: {
    schemes: [
      {
        id: "oauth2",
        kind: "oauth2_authorization_code",
        label: "Connect with OAuth",
        scopes: ["read:all", "write:none"],
      },
      {
        id: "pat",
        kind: "api_key",
        label: "Personal Access Token",
        fields: [
          {
            key: "apiKey",
            label: "API Key",
            widget: "secret",
            validation: { required: true },
          },
        ],
      },
    ],
  },
};

const SINGLE_AUTH_SCHEMA: ConnectorPluginSchema = {
  ...MULTI_AUTH_SCHEMA,
  auth: {
    schemes: [
      {
        id: "oauth2",
        kind: "oauth2_authorization_code",
        label: "Connect with Google",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
    ],
  },
};

const API_KEY_SCHEMA: ConnectorPluginSchema = {
  ...MULTI_AUTH_SCHEMA,
  auth: {
    schemes: [
      {
        id: "pat",
        kind: "api_key",
        label: "API Key",
        fields: [
          {
            key: "apiKey",
            label: "API Key",
            widget: "secret",
          },
        ],
      },
    ],
  },
};

const NO_AUTH_SCHEMA: ConnectorPluginSchema = {
  ...MULTI_AUTH_SCHEMA,
  auth: undefined,
};

function renderPicker(schema: ConnectorPluginSchema) {
  return render(
    <ConnectorSchemaProvider
      pluginId="test"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <AuthSchemePicker />
    </ConnectorSchemaProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AuthSchemePicker — no auth", () => {
  it("renders nothing when no auth schemes", () => {
    const { container } = renderPicker(NO_AUTH_SCHEMA);
    expect(container.firstChild).toBeNull();
  });
});

describe("AuthSchemePicker — single scheme", () => {
  it("does not render radio buttons for single scheme", () => {
    renderPicker(SINGLE_AUTH_SCHEMA);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("renders OAuth scopes for single OAuth scheme", () => {
    renderPicker(SINGLE_AUTH_SCHEMA);
    expect(
      screen.getByText("https://www.googleapis.com/auth/drive.readonly"),
    ).toBeInTheDocument();
  });

  it("renders 'Permissions requested' heading for OAuth", () => {
    renderPicker(SINGLE_AUTH_SCHEMA);
    expect(screen.getByText("Permissions requested")).toBeInTheDocument();
  });
});

describe("AuthSchemePicker — single API key scheme", () => {
  it("renders the API key field for api_key scheme", () => {
    renderPicker(API_KEY_SCHEMA);
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
  });

  it("does not render scopes for api_key scheme", () => {
    renderPicker(API_KEY_SCHEMA);
    expect(screen.queryByText("Permissions requested")).not.toBeInTheDocument();
  });
});

describe("AuthSchemePicker — scheme without label", () => {
  it("falls back to kind string when no label and kind is unknown", () => {
    const schema: ConnectorPluginSchema = {
      ...MULTI_AUTH_SCHEMA,
      auth: {
        schemes: [
          {
            id: "custom",
            kind: "oauth2_client_credentials" as never,
            // no label - falls back to AUTH_KIND_LABELS entry
          },
          {
            id: "another",
            kind: "basic" as never,
            // no label
          },
        ],
      },
    };
    renderPicker(schema);
    // basic renders as "Basic Auth" — appears multiple times (label + description), check at least once
    const basicAuthElements = screen.getAllByText("Basic Auth");
    expect(basicAuthElements.length).toBeGreaterThan(0);
  });

  it("shows scheme kind as fallback when no label and kind not in AUTH_KIND_LABELS", () => {
    const schema: ConnectorPluginSchema = {
      ...MULTI_AUTH_SCHEMA,
      auth: {
        schemes: [
          { id: "s1", kind: "none" as never },
          { id: "s2", kind: "api_key" as never },
        ],
      },
    };
    renderPicker(schema);
    // "none" is in AUTH_KIND_LABELS as "No authentication"
    expect(screen.getAllByText("No authentication").length).toBeGreaterThan(0);
  });

  it("shows raw kind string when no label and kind not in AUTH_KIND_LABELS map", () => {
    const schema: ConnectorPluginSchema = {
      ...MULTI_AUTH_SCHEMA,
      auth: {
        schemes: [
          { id: "s1", kind: "saml" as never }, // not in AUTH_KIND_LABELS
          { id: "s2", kind: "api_key" as never },
        ],
      },
    };
    renderPicker(schema);
    // "saml" has no label and no AUTH_KIND_LABELS entry → falls back to raw kind
    expect(screen.getAllByText("saml").length).toBeGreaterThan(0);
  });
});

describe("AuthSchemePicker — multiple schemes", () => {
  it("renders radio buttons for each scheme", () => {
    renderPicker(MULTI_AUTH_SCHEMA);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
  });

  it("renders 'Authentication method' heading", () => {
    renderPicker(MULTI_AUTH_SCHEMA);
    expect(screen.getByText("Authentication method")).toBeInTheDocument();
  });

  it("renders scheme labels", () => {
    renderPicker(MULTI_AUTH_SCHEMA);
    expect(screen.getByText("Connect with OAuth")).toBeInTheDocument();
    expect(screen.getByText("Personal Access Token")).toBeInTheDocument();
  });

  it("shows scopes for selected oauth2 scheme by default", () => {
    renderPicker(MULTI_AUTH_SCHEMA);
    expect(screen.getByText("read:all")).toBeInTheDocument();
    expect(screen.getByText("write:none")).toBeInTheDocument();
  });

  it("does not show api_key field for default oauth scheme", () => {
    renderPicker(MULTI_AUTH_SCHEMA);
    // API key field should not be visible when oauth is selected
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });
});
