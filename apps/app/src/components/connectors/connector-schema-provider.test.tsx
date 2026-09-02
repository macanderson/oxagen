// @vitest-environment jsdom
/**
 * connector-schema-provider.test.tsx — Unit tests for ConnectorSchemaProvider context.
 *
 * Tests: context values, form state mutations, auth scheme selection, field visibility,
 * default value extraction from schema.
 */

import { render, cleanup, act } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import {
  ConnectorSchemaProvider,
  useConnectorSchema,
} from "./connector-schema-provider";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

// ── Minimal schema fixture ─────────────────────────────────────────────────────

const SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "test-connector",
    displayName: "Test Connector",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  auth: {
    schemes: [
      { id: "oauth2", kind: "oauth2_authorization_code", scopes: ["read:all"] },
      {
        id: "pat",
        kind: "api_key",
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
  config: {
    fields: [
      {
        key: "organizations",
        label: "Organizations",
        widget: "tag-input",
        defaultValue: ["default-org"],
        validation: { required: true, minItems: 1 },
      },
      {
        key: "syncDepth",
        label: "Sync Depth",
        widget: "number",
        defaultValue: 90,
      },
      {
        key: "conditionalField",
        label: "Conditional",
        widget: "text",
        dependsOn: { field: "organizations", value: ["special"] },
      },
    ],
  },
};

// ── Consumer helper ────────────────────────────────────────────────────────────

interface CapturedCtx {
  values: Record<string, unknown>;
  errors: Array<{ field: string; message: string; code: string }>;
  selectedAuthSchemeId: string | null;
  touched: Set<string>;
}

function ContextCapture({
  onCapture,
}: {
  onCapture: (ctx: CapturedCtx) => void;
}) {
  const ctx = useConnectorSchema();
  React.useEffect(() => {
    onCapture({
      values: ctx.formState.values,
      errors: ctx.formState.errors,
      selectedAuthSchemeId: ctx.selectedAuthSchemeId,
      touched: ctx.formState.touched,
    });
  });
  return null;
}

function renderWithProvider(schema: ConnectorPluginSchema) {
  let captured: CapturedCtx = {
    values: {},
    errors: [],
    selectedAuthSchemeId: null,
    touched: new Set(),
  };
  let ctxRef!: ReturnType<typeof useConnectorSchema>;

  function Consumer() {
    ctxRef = useConnectorSchema();
    return (
      <ContextCapture
        onCapture={(c) => {
          captured = c;
        }}
      />
    );
  }

  render(
    <ConnectorSchemaProvider
      pluginId="test-connector"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <Consumer />
    </ConnectorSchemaProvider>,
  );

  return {
    getCaptured: () => captured,
    getCtx: () => ctxRef,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ConnectorSchemaProvider — initialisation", () => {
  it("exposes the schema when initialSchema is provided", () => {
    const { getCtx } = renderWithProvider(SCHEMA);
    expect(getCtx().schema?.metadata.id).toBe("test-connector");
  });

  it("loading is false when initialSchema is provided", () => {
    const { getCtx } = renderWithProvider(SCHEMA);
    expect(getCtx().loading).toBe(false);
  });

  it("sets default values from config fields", () => {
    const { getCaptured } = renderWithProvider(SCHEMA);
    expect(getCaptured().values.organizations).toEqual(["default-org"]);
    expect(getCaptured().values.syncDepth).toBe(90);
  });

  it("selects the first auth scheme by default", () => {
    const { getCaptured } = renderWithProvider(SCHEMA);
    expect(getCaptured().selectedAuthSchemeId).toBe("oauth2");
  });

  it("starts with no errors", () => {
    const { getCaptured } = renderWithProvider(SCHEMA);
    expect(getCaptured().errors).toHaveLength(0);
  });

  it("starts with empty touched set", () => {
    const { getCaptured } = renderWithProvider(SCHEMA);
    expect(getCaptured().touched.size).toBe(0);
  });
});

describe("ConnectorSchemaProvider — setFieldValue", () => {
  it("updates a field value", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().setFieldValue("organizations", ["acme-corp"]);
    });
    expect(getCaptured().values.organizations).toEqual(["acme-corp"]);
  });

  it("clears errors for the changed field", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().setErrors([
        { field: "organizations", message: "Required", code: "required" },
      ]);
    });
    expect(getCaptured().errors).toHaveLength(1);

    act(() => {
      getCtx().setFieldValue("organizations", ["acme"]);
    });
    expect(getCaptured().errors).toHaveLength(0);
  });

  it("preserves other field values when updating one", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().setFieldValue("syncDepth", 180);
    });
    expect(getCaptured().values.organizations).toEqual(["default-org"]);
    expect(getCaptured().values.syncDepth).toBe(180);
  });
});

describe("ConnectorSchemaProvider — touchField", () => {
  it("adds a key to touched set", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().touchField("organizations");
    });
    expect(getCaptured().touched.has("organizations")).toBe(true);
  });

  it("does not remove other touched keys", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().touchField("organizations");
      getCtx().touchField("syncDepth");
    });
    expect(getCaptured().touched.has("organizations")).toBe(true);
    expect(getCaptured().touched.has("syncDepth")).toBe(true);
  });
});

describe("ConnectorSchemaProvider — selectAuthScheme", () => {
  it("changes the selected auth scheme id", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().selectAuthScheme("pat");
    });
    expect(getCaptured().selectedAuthSchemeId).toBe("pat");
  });

  it("sets default values for the new scheme's fields", () => {
    const schemaWithDefaults: ConnectorPluginSchema = {
      ...SCHEMA,
      auth: {
        schemes: [
          { id: "oauth2", kind: "oauth2_authorization_code" },
          {
            id: "pat",
            kind: "api_key",
            fields: [
              {
                key: "apiKey",
                label: "API Key",
                widget: "secret",
                defaultValue: "",
              },
            ],
          },
        ],
      },
    };
    const { getCtx, getCaptured } = renderWithProvider(schemaWithDefaults);
    act(() => {
      getCtx().selectAuthScheme("pat");
    });
    expect(getCaptured().values.apiKey).toBe("");
  });
});

describe("ConnectorSchemaProvider — setErrors / clearErrors", () => {
  it("stores errors set via setErrors", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().setErrors([
        { field: "organizations", message: "Required", code: "required" },
        { field: "syncDepth", message: "Too small", code: "min" },
      ]);
    });
    expect(getCaptured().errors).toHaveLength(2);
    expect(getCaptured().errors[0]?.field).toBe("organizations");
  });

  it("clearErrors removes all errors", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().setErrors([{ field: "x", message: "bad", code: "required" }]);
    });
    act(() => {
      getCtx().clearErrors();
    });
    expect(getCaptured().errors).toHaveLength(0);
  });
});

describe("ConnectorSchemaProvider — isFieldVisible", () => {
  it("returns true when no dependsOn", () => {
    const { getCtx } = renderWithProvider(SCHEMA);
    expect(getCtx().isFieldVisible("organizations")).toBe(true);
  });

  it("returns false when dependsOn condition is not met", () => {
    const { getCtx } = renderWithProvider(SCHEMA);
    // organizations is ["default-org"], condition checks for ["special"]
    expect(
      getCtx().isFieldVisible("conditionalField", {
        field: "organizations",
        value: ["special"],
      }),
    ).toBe(false);
  });

  it("returns true when dependsOn condition is exactly met", () => {
    const { getCtx } = renderWithProvider(SCHEMA);
    act(() => {
      // Simple string comparison — set the exact value
      getCtx().setFieldValue("toggle", "on");
    });
    expect(
      getCtx().isFieldVisible("someField", { field: "toggle", value: "on" }),
    ).toBe(true);
  });
});

describe("ConnectorSchemaProvider — resetForm", () => {
  it("resets values to defaults", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().setFieldValue("syncDepth", 999);
    });
    expect(getCaptured().values.syncDepth).toBe(999);
    act(() => {
      getCtx().resetForm();
    });
    expect(getCaptured().values.syncDepth).toBe(90);
  });

  it("resets selected auth scheme to first scheme", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().selectAuthScheme("pat");
    });
    expect(getCaptured().selectedAuthSchemeId).toBe("pat");
    act(() => {
      getCtx().resetForm();
    });
    expect(getCaptured().selectedAuthSchemeId).toBe("oauth2");
  });

  it("clears errors on reset", () => {
    const { getCtx, getCaptured } = renderWithProvider(SCHEMA);
    act(() => {
      getCtx().setErrors([{ field: "x", message: "err", code: "required" }]);
    });
    act(() => {
      getCtx().resetForm();
    });
    expect(getCaptured().errors).toHaveLength(0);
  });
});

describe("ConnectorSchemaProvider — throws without provider", () => {
  it("throws when useConnectorSchema used outside provider", () => {
    function Bare() {
      useConnectorSchema();
      return null;
    }
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(
      "useConnectorSchema must be used within ConnectorSchemaProvider",
    );
    consoleError.mockRestore();
  });
});

describe("ConnectorSchemaProvider — fetch (no initialSchema)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets fetchError when server returns non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not found",
        json: async () => ({ error: "not found" }),
      }),
    );

    let capturedError: string | null = null;
    function ErrorCapture() {
      const ctx = useConnectorSchema();
      React.useEffect(() => {
        capturedError = ctx.fetchError;
      });
      return null;
    }

    render(
      <ConnectorSchemaProvider
        pluginId="missing"
        orgSlug="acme"
        workspaceSlug="main"
      >
        <ErrorCapture />
      </ConnectorSchemaProvider>,
    );

    // Wait for the async fetch chain to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(capturedError).toBeTruthy();
  });

  it("sets schema when server returns ok response", async () => {
    const mockSchema: ConnectorPluginSchema = {
      apiVersion: "oxagen.ai/v1alpha1",
      kind: "ConnectorPlugin",
      metadata: {
        id: "fetched",
        displayName: "Fetched Connector",
        version: "1.0.0",
        schemaVersion: "1",
        publisher: { name: "Oxagen", verified: true },
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockSchema,
        text: async () => JSON.stringify(mockSchema),
      }),
    );

    let capturedId: string | undefined;
    function SchemaCapture() {
      const ctx = useConnectorSchema();
      React.useEffect(() => {
        capturedId = ctx.schema?.metadata.id;
      });
      return null;
    }

    render(
      <ConnectorSchemaProvider
        pluginId="fetched"
        orgSlug="acme"
        workspaceSlug="main"
      >
        <SchemaCapture />
      </ConnectorSchemaProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(capturedId).toBe("fetched");
  });

  it("sets fetchError when fetch network throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );

    let capturedError: string | null = null;
    function ErrorCapture() {
      const ctx = useConnectorSchema();
      React.useEffect(() => {
        capturedError = ctx.fetchError;
      });
      return null;
    }

    render(
      <ConnectorSchemaProvider
        pluginId="gone"
        orgSlug="acme"
        workspaceSlug="main"
      >
        <ErrorCapture />
      </ConnectorSchemaProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(capturedError).toBe("Network error");
  });
});

// ── initialValues seeding (edit flow) ──────────────────────────────────────────

describe("ConnectorSchemaProvider — initialValues", () => {
  function renderWithInitialValues(initialValues: Record<string, unknown>) {
    let captured: Record<string, unknown> = {};
    function Capture() {
      const ctx = useConnectorSchema();
      React.useEffect(() => {
        captured = ctx.formState.values;
      });
      return null;
    }
    render(
      <ConnectorSchemaProvider
        pluginId="test-connector"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={SCHEMA}
        initialValues={initialValues}
      >
        <Capture />
      </ConnectorSchemaProvider>,
    );
    return () => captured;
  }

  it("seeds provided values over schema defaults", () => {
    const get = renderWithInitialValues({
      organizations: ["acme-eng"],
      syncDepth: 30,
    });
    expect(get().organizations).toEqual(["acme-eng"]);
    expect(get().syncDepth).toBe(30);
  });

  it("keeps non-schema operational keys present in initialValues", () => {
    const get = renderWithInitialValues({
      organizations: ["acme-eng"],
      owner: "acme",
      repo: "core",
    });
    // Operational keys not described by the manifest survive in form state so a
    // later merge-submit can preserve them.
    expect(get().owner).toBe("acme");
    expect(get().repo).toBe("core");
  });

  it("falls back to schema defaults for fields not in initialValues", () => {
    const get = renderWithInitialValues({ organizations: ["acme-eng"] });
    // syncDepth not seeded → keeps the manifest default of 90.
    expect(get().syncDepth).toBe(90);
  });
});
