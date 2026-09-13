// @vitest-environment jsdom
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";
import type { ComponentProps } from "react";
import { CredentialsStep } from "./credentials-step";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

const SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "custom-sql",
    displayName: "Custom SQL",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  auth: {
    schemes: [
      {
        id: "connection_string",
        kind: "api_key",
        label: "Database Connection String",
        fields: [
          {
            key: "apiKey",
            label: "Connection String",
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
        key: "queries",
        label: "SQL Queries",
        widget: "code",
        validation: { required: true },
      },
    ],
  },
};

function baseProps(
  overrides: Partial<ComponentProps<typeof CredentialsStep>> = {},
) {
  return {
    connectorId: "custom-sql",
    connectorDisplayName: "Custom SQL",
    orgSlug: "acme",
    workspaceSlug: "main",
    schema: SCHEMA,
    schemaLoading: false,
    schemaError: null,
    onRetrySchema: vi.fn(),
    onValidate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    onSubmit: vi.fn(),
    submitting: false,
    submitError: null,
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("CredentialsStep", () => {
  it("renders a skeleton while the schema is loading", () => {
    render(
      <CredentialsStep {...baseProps({ schema: null, schemaLoading: true })} />,
    );
    expect(screen.getByTestId("credentials-skeleton")).toBeInTheDocument();
  });

  it("renders an error state with retry when the schema failed to load", async () => {
    const onRetrySchema = vi.fn();
    render(
      <CredentialsStep
        {...baseProps({
          schema: null,
          schemaLoading: false,
          schemaError: "network error",
          onRetrySchema,
        })}
      />,
    );
    expect(
      screen.getByText("Couldn't load this connector's configuration"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetrySchema).toHaveBeenCalled();
  });

  it("blocks submission and shows inline errors when required fields are empty", async () => {
    const onValidate = vi.fn();
    const onSubmit = vi.fn();
    render(<CredentialsStep {...baseProps({ onValidate, onSubmit })} />);

    await userEvent.click(screen.getByTestId("credentials-next-btn"));

    expect(onValidate).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // Both required fields (apiKey, queries) render their own inline error
    // PLUS the top summary banner — all carry role="alert", so assert on the
    // count rather than a single element (getByRole throws on >1 match).
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it("partitions form values into connectionConfig/authCredential and submits on success", async () => {
    const onValidate = vi.fn().mockResolvedValue({ valid: true, errors: [] });
    const onSubmit = vi.fn();
    render(<CredentialsStep {...baseProps({ onValidate, onSubmit })} />);

    await userEvent.type(
      screen.getByLabelText("Connection String", { exact: false }),
      "postgresql://u:p@host/db",
    );
    // Avoid curly braces — userEvent.type() treats {..} as special key sequences.
    await userEvent.type(
      screen.getByLabelText("SQL Queries", { exact: false }),
      "SELECT star FROM orders",
    );

    await userEvent.click(screen.getByTestId("credentials-next-btn"));

    await waitFor(() => expect(onValidate).toHaveBeenCalled());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted.displayName).toBe("Custom SQL");
    expect(submitted.authCredential.apiKey).toBe("postgresql://u:p@host/db");
    expect(submitted.authCredential.type).toBe("api_key");
    expect(submitted.connectionConfig.queries).toBe("SELECT star FROM orders");
  });

  it("shows server-side validation errors returned by onValidate and does not submit", async () => {
    const onValidate = vi.fn().mockResolvedValue({
      valid: false,
      errors: [
        {
          field: "apiKey",
          message: "Invalid connection string",
          code: "pattern",
        },
      ],
    });
    const onSubmit = vi.fn();
    render(<CredentialsStep {...baseProps({ onValidate, onSubmit })} />);

    await userEvent.type(
      screen.getByLabelText("Connection String", { exact: false }),
      "not-a-real-connection-string",
    );
    await userEvent.type(
      screen.getByLabelText("SQL Queries", { exact: false }),
      "SELECT 1",
    );
    await userEvent.click(screen.getByTestId("credentials-next-btn"));

    // The message renders both inline (under the field) and in the summary
    // banner — assert at least one match instead of a single getByText,
    // which throws on >1 match.
    await waitFor(() =>
      expect(
        screen.getAllByText("Invalid connection string").length,
      ).toBeGreaterThan(0),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
