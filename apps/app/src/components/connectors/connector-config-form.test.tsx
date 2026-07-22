// @vitest-environment jsdom
/**
 * connector-config-form.test.tsx — Unit tests for ConnectorConfigForm.
 *
 * Covers: loading skeleton, error state, section rendering, submit button,
 * and cancel button.
 */

import { render, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as React from "react";
import { ConnectorSchemaProvider } from "./connector-schema-provider";
import { ConnectorConfigForm } from "./connector-config-form";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

// ── Fixtures ───────────────────────────────────────────────────────────────────

const FULL_SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "github",
    displayName: "GitHub",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  auth: {
    schemes: [
      {
        id: "oauth2",
        kind: "oauth2_authorization_code",
        label: "OAuth",
        scopes: ["repo"],
      },
      {
        id: "pat",
        kind: "api_key",
        label: "PAT",
        fields: [{ key: "apiKey", label: "Token", widget: "secret" }],
      },
    ],
  },
  config: {
    fields: [
      {
        key: "orgs",
        label: "Organizations",
        widget: "tag-input",
        validation: { required: true, minItems: 1 },
      },
      {
        key: "syncDepth",
        label: "Sync Depth",
        widget: "number",
        defaultValue: 90,
      },
    ],
  },
  recordTypes: {
    selectionMode: "multi",
    items: [
      { id: "pr", displayName: "Pull Requests", defaultEnabled: true },
      { id: "issue", displayName: "Issues", defaultEnabled: false },
    ],
  },
  filters: {
    pathFilters: { enabled: true, defaultIgnore: ["node_modules/**"] },
    labelFilters: { enabled: false },
  },
  sync: {
    delivery: "webhook",
    pollingSupported: true,
    polling: { defaultIntervalSeconds: 300, minIntervalSeconds: 60 },
  },
};

function renderForm(
  schema: ConnectorPluginSchema,
  props: Partial<Parameters<typeof ConnectorConfigForm>[0]> = {},
) {
  return render(
    <ConnectorSchemaProvider
      pluginId="github"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <ConnectorConfigForm orgSlug="acme" workspaceSlug="main" {...props} />
    </ConnectorSchemaProvider>,
  );
}

// ── Loading state ───────────────────────────────────────────────────────────────

describe("ConnectorConfigForm — loading state", () => {
  it("renders skeleton when schema is loading", () => {
    // Render without initialSchema to trigger loading
    render(
      <ConnectorSchemaProvider
        pluginId="github"
        orgSlug="acme"
        workspaceSlug="main"
      >
        <ConnectorConfigForm orgSlug="acme" workspaceSlug="main" />
      </ConnectorSchemaProvider>,
    );
    // Should show skeleton divs, no form submit button
    expect(
      screen.queryByRole("button", { name: /connect/i }),
    ).not.toBeInTheDocument();
  });
});

// Helper to render with a schema that has a fetch error
function FetchErrorWrapper({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return <>{children}</>;
}

describe("ConnectorConfigForm — fetch error state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Schema fetch failed")),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows fetch error message when schema fails to load", async () => {
    render(
      <ConnectorSchemaProvider
        pluginId="github"
        orgSlug="acme"
        workspaceSlug="main"
      >
        <ConnectorConfigForm orgSlug="acme" workspaceSlug="main" />
      </ConnectorSchemaProvider>,
    );
    // Wait for error to appear
    const errorMsg = await screen.findByText(
      /failed to load connector schema/i,
      {},
      { timeout: 3000 },
    );
    expect(errorMsg).toBeInTheDocument();
  });
});

// ── Form sections ──────────────────────────────────────────────────────────────

describe("ConnectorConfigForm — sections", () => {
  it("renders Authentication section heading", () => {
    renderForm(FULL_SCHEMA);
    expect(screen.getByText("Authentication")).toBeInTheDocument();
  });

  it("renders Configuration section heading", () => {
    renderForm(FULL_SCHEMA);
    expect(screen.getByText("Configuration")).toBeInTheDocument();
  });

  it("renders record type selector", () => {
    renderForm(FULL_SCHEMA);
    expect(screen.getByText("Record types to sync")).toBeInTheDocument();
  });

  it("renders Filters section", () => {
    renderForm(FULL_SCHEMA);
    expect(screen.getByText("Filters")).toBeInTheDocument();
  });

  it("renders Sync cadence section", () => {
    renderForm(FULL_SCHEMA);
    expect(screen.getByText("Sync cadence")).toBeInTheDocument();
  });
});

// ── Submit / cancel ───────────────────────────────────────────────────────────

describe("ConnectorConfigForm — actions", () => {
  it("renders Connect submit button in install mode", () => {
    renderForm(FULL_SCHEMA);
    expect(
      screen.getByRole("button", { name: /connect/i }),
    ).toBeInTheDocument();
  });

  it("renders Save changes submit button in configure mode", () => {
    renderForm(FULL_SCHEMA, { mode: "configure" });
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });

  it("renders Cancel button when onCancel is provided", () => {
    renderForm(FULL_SCHEMA, { onCancel: vi.fn() });
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("does not render Cancel button when onCancel is not provided", () => {
    renderForm(FULL_SCHEMA);
    expect(
      screen.queryByRole("button", { name: /cancel/i }),
    ).not.toBeInTheDocument();
  });

  it("calls onCancel when Cancel button is clicked", async () => {
    const onCancel = vi.fn();
    renderForm(FULL_SCHEMA, { onCancel });
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("ConnectorConfigForm — client validation on submit", () => {
  beforeEach(() => {
    // Mock fetch to avoid actual network calls
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "not found" }),
        text: async () => "not found",
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows validation errors when required fields are empty", async () => {
    renderForm(FULL_SCHEMA);
    // Submit without filling required fields
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));
    // Should show at least one error (organizations is required)
    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
  });
});

// ── Submit error display ─────────────────────────────────────────────────────

describe("ConnectorConfigForm — submit error (no required fields)", () => {
  const NO_REQUIRED_SCHEMA: ConnectorPluginSchema = {
    apiVersion: "oxagen.ai/v1alpha1",
    kind: "ConnectorPlugin",
    metadata: {
      id: "simple",
      displayName: "Simple",
      version: "1.0.0",
      schemaVersion: "1",
      publisher: { name: "Oxagen", verified: true },
    },
    config: {
      fields: [
        // No required fields — client validation passes immediately
        { key: "name", label: "Name", widget: "text" },
      ],
    },
  };

  beforeEach(() => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // schema/validate call — return valid
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ valid: true, errors: [] }),
            text: async () => '{"valid":true,"errors":[]}',
          });
        }
        // install call — return error
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({ error: "Integration already exists" }),
          text: async () => '{"error":"Integration already exists"}',
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows submit error alert when install call fails", async () => {
    render(
      <ConnectorSchemaProvider
        pluginId="simple"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={NO_REQUIRED_SCHEMA}
      >
        <ConnectorConfigForm orgSlug="acme" workspaceSlug="main" />
      </ConnectorSchemaProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    // Wait for async submit flow to settle
    const alertEl = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alertEl).toHaveTextContent("Integration already exists");
  });
});

// ── Validate non-2xx error surfacing ─────────────────────────────────────────
// When the plugin-schema validate endpoint returns a non-2xx (500, 401, 503),
// the original code silently skipped server validation and proceeded to submit.
// The fix surfaces the error to the user instead of silently bypassing validation.

describe("ConnectorConfigForm — validate endpoint non-2xx is surfaced (not silently bypassed)", () => {
  const NO_REQUIRED_SCHEMA: ConnectorPluginSchema = {
    apiVersion: "oxagen.ai/v1alpha1",
    kind: "ConnectorPlugin",
    metadata: {
      id: "simple",
      displayName: "Simple",
      version: "1.0.0",
      schemaVersion: "1",
      publisher: { name: "Oxagen", verified: true },
    },
    config: {
      fields: [{ key: "name", label: "Name", widget: "text" }],
    },
  };

  function renderNoRequired(
    props: Partial<Parameters<typeof ConnectorConfigForm>[0]> = {},
  ) {
    return render(
      <ConnectorSchemaProvider
        pluginId="simple"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={NO_REQUIRED_SCHEMA}
      >
        <ConnectorConfigForm orgSlug="acme" workspaceSlug="main" {...props} />
      </ConnectorSchemaProvider>,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an error alert when validate returns 500 (does NOT proceed to install)", async () => {
    let installCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string) => {
        if ((_url as string).includes("validate")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: "Internal error" }),
          });
        }
        // This should NOT be reached
        installCalled = true;
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobId: "job-1", status: "queued" }),
        });
      }),
    );

    renderNoRequired();
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    const alertEl = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alertEl).toHaveTextContent(/validation service unavailable/i);
    expect(alertEl).toHaveTextContent("500");
    // The install endpoint must NOT have been called
    expect(installCalled).toBe(false);
  });

  it("shows an error alert when validate returns 401 (does NOT proceed to install)", async () => {
    let installCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string) => {
        if ((_url as string).includes("validate")) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: async () => ({ error: "Unauthorized" }),
          });
        }
        installCalled = true;
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobId: "job-1", status: "queued" }),
        });
      }),
    );

    renderNoRequired();
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    const alertEl = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alertEl).toHaveTextContent("401");
    expect(installCalled).toBe(false);
  });

  it("proceeds to install when validate returns 200 with { valid: true }", async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string) => {
        if ((_url as string).includes("validate")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ valid: true, errors: [] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobId: "job-ok", status: "queued" }),
        });
      }),
    );

    renderNoRequired({ onSuccess });
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    await waitFor(
      () => {
        expect(onSuccess).toHaveBeenCalledWith({
          jobId: "job-ok",
          status: "queued",
        });
      },
      { timeout: 3000 },
    );
  });
});

// ── Install/configure endpoint + HTTP method regression ─────────────────────
// Bug found while wiring the wizard onto a real route: the component posted
// to /integrations/install (no such route — only POST /integrations exists)
// and always used POST even in configure mode (the route only accepts
// PATCH /integrations/:id/configure). Both silently 404'd since this
// component had no consumer to notice until now.

describe("ConnectorConfigForm — install/configure hit the real routes", () => {
  const NO_REQUIRED_SCHEMA: ConnectorPluginSchema = {
    apiVersion: "oxagen.ai/v1alpha1",
    kind: "ConnectorPlugin",
    metadata: {
      id: "simple",
      displayName: "Simple",
      version: "1.0.0",
      schemaVersion: "1",
      publisher: { name: "Oxagen", verified: true },
    },
    config: {
      fields: [{ key: "name", label: "Name", widget: "text" }],
    },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchRecording(
    calls: Array<{ url: string; method: string | undefined }>,
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        if (url.includes("validate")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ valid: true, errors: [] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobId: "job-1", status: "queued" }),
        });
      }),
    );
  }

  it("install mode POSTs to /integrations (not /integrations/install)", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    stubFetchRecording(calls);

    render(
      <ConnectorSchemaProvider
        pluginId="simple"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={NO_REQUIRED_SCHEMA}
      >
        <ConnectorConfigForm
          orgSlug="acme"
          workspaceSlug="main"
          mode="install"
        />
      </ConnectorSchemaProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    await waitFor(() => {
      const installCall = calls.find((c) => !c.url.includes("validate"));
      expect(installCall).toBeDefined();
      expect(installCall?.url).toBe("/api/v1/acme/main/integrations");
      expect(installCall?.method).toBe("POST");
    });
  });

  it("configure mode PATCHes /integrations/:id/configure (not POST)", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    stubFetchRecording(calls);

    render(
      <ConnectorSchemaProvider
        pluginId="simple"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={NO_REQUIRED_SCHEMA}
      >
        <ConnectorConfigForm
          orgSlug="acme"
          workspaceSlug="main"
          mode="configure"
          integrationId="conn-123"
        />
      </ConnectorSchemaProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /save changes/i }),
    );

    await waitFor(() => {
      const configureCall = calls.find((c) => !c.url.includes("validate"));
      expect(configureCall).toBeDefined();
      expect(configureCall?.url).toBe(
        "/api/v1/acme/main/integrations/conn-123/configure",
      );
      expect(configureCall?.method).toBe("PATCH");
    });
  });
});

// ── No sections ───────────────────────────────────────────────────────────────

describe("ConnectorConfigForm — minimal schema", () => {
  it("renders form with no sections for bare schema", () => {
    const minimalSchema: ConnectorPluginSchema = {
      apiVersion: "oxagen.ai/v1alpha1",
      kind: "ConnectorPlugin",
      metadata: {
        id: "bare",
        displayName: "Bare",
        version: "1.0.0",
        schemaVersion: "1",
        publisher: { name: "Oxagen", verified: true },
      },
    };
    renderForm(minimalSchema);
    expect(
      screen.getByRole("button", { name: /connect/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Authentication")).not.toBeInTheDocument();
    expect(screen.queryByText("Configuration")).not.toBeInTheDocument();
  });
});
