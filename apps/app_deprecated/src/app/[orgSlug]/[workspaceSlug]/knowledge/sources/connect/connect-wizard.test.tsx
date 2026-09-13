// @vitest-environment jsdom
/**
 * connect-wizard.test.tsx — integration test for the "Connect a source"
 * wizard orchestrator. Drives the happy path end-to-end (pick → credentials
 * → preview → mappings → confirm → redirect) against mocked server actions,
 * plus the resume-via-?connectionId= shortcut that skips straight to
 * Mappings when saved mappings already exist.
 */

import {
  render,
  cleanup,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { ConnectSourceWizard } from "./connect-wizard";
import type { ConnectorCatalogEntry } from "@/components/knowledge/connect/wizard-types";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const {
  mockGetConnectSourceSchemaAction,
  mockValidateConnectSourceConfigAction,
  mockCreateSourceConnectionAction,
  mockPreviewSourceConnectionAction,
  mockSuggestSourceMappingsAction,
  mockConfirmSourceMappingsAction,
  mockConfigureSourceIntegrationAction,
} = vi.hoisted(() => ({
  mockGetConnectSourceSchemaAction: vi.fn(),
  mockValidateConnectSourceConfigAction: vi.fn(),
  mockCreateSourceConnectionAction: vi.fn(),
  mockPreviewSourceConnectionAction: vi.fn(),
  mockSuggestSourceMappingsAction: vi.fn(),
  mockConfirmSourceMappingsAction: vi.fn(),
  mockConfigureSourceIntegrationAction: vi.fn(),
}));

vi.mock("./actions", () => ({
  getConnectSourceSchemaAction: mockGetConnectSourceSchemaAction,
  validateConnectSourceConfigAction: mockValidateConnectSourceConfigAction,
  createSourceConnectionAction: mockCreateSourceConnectionAction,
  previewSourceConnectionAction: mockPreviewSourceConnectionAction,
  suggestSourceMappingsAction: mockSuggestSourceMappingsAction,
  confirmSourceMappingsAction: mockConfirmSourceMappingsAction,
  configureSourceIntegrationAction: mockConfigureSourceIntegrationAction,
}));

const CONNECTORS: ConnectorCatalogEntry[] = [
  {
    connectorId: "custom-sql",
    displayName: "Custom SQL",
    description: "Sync records from any relational database.",
    icon: "database",
    isOAuthOnly: false,
  },
];

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
  sync: { delivery: "polling" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigureSourceIntegrationAction.mockResolvedValue({
    ok: true,
    value: {
      integrationId: "con_123",
      displayName: "My DB",
      syncCadence: "manual",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
});

describe("ConnectSourceWizard", () => {
  it("drives the full happy path: pick → credentials → preview → mappings → confirm → redirect", async () => {
    mockGetConnectSourceSchemaAction.mockResolvedValue({
      ok: true,
      value: SCHEMA,
    });
    mockValidateConnectSourceConfigAction.mockResolvedValue({
      ok: true,
      value: { valid: true, errors: [] },
    });
    mockCreateSourceConnectionAction.mockResolvedValue({
      ok: true,
      value: {
        connectionId: "uuid-1",
        publicId: "con_123",
        status: "pending_setup",
        connectorId: "custom-sql",
        displayName: "My DB",
      },
    });
    mockPreviewSourceConnectionAction.mockResolvedValue({
      ok: true,
      value: {
        recordTypes: [
          {
            sourceRecordType: "custom",
            displayName: "Custom Records",
            sampleCount: 1,
            sampleFields: ["id"],
            sampleRecords: [{ id: "1" }],
          },
        ],
      },
    });
    mockSuggestSourceMappingsAction.mockResolvedValue({
      ok: true,
      value: {
        suggestions: [
          {
            sourceRecordType: "custom",
            suggestedEntityType: "task",
            suggestedPropertyMappings: { id: "externalId" },
            confidence: 0.9,
            reasoning: "Looks like a task.",
          },
        ],
        suggestionIds: ["sug_1"],
      },
    });
    mockConfirmSourceMappingsAction.mockResolvedValue({
      ok: true,
      value: {
        mappingsCreated: 1,
        mappingsUpdated: 0,
        connectionStatus: "active",
      },
    });

    render(
      <ConnectSourceWizard
        orgSlug="acme"
        workspaceSlug="main"
        connectors={CONNECTORS}
      />,
    );

    // Step 1 — pick connector
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("connector-select-custom-sql"));

    // Step 2 — credentials
    await waitFor(() =>
      expect(mockGetConnectSourceSchemaAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        connectorId: "custom-sql",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Step 2 of 5")).toBeInTheDocument(),
    );
    await userEvent.type(
      screen.getByLabelText("Connection String", { exact: false }),
      "postgresql://u:p@host/db",
    );
    await userEvent.type(
      screen.getByLabelText("SQL Queries", { exact: false }),
      "SELECT star FROM orders",
    );
    await userEvent.click(screen.getByTestId("credentials-next-btn"));

    // Step 3 — preview
    await waitFor(() =>
      expect(mockCreateSourceConnectionAction).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(mockPreviewSourceConnectionAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        connectionId: "con_123",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("preview-record-type-custom"),
      ).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByTestId("preview-next-btn"));

    // Step 4 — mappings
    await waitFor(() =>
      expect(mockSuggestSourceMappingsAction).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "con_123" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mapping-row-custom")).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId("mapping-row-custom")).getByDisplayValue(
        "task",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("mappings-next-btn"));

    // Step 5 — confirm
    await waitFor(() =>
      expect(screen.getByTestId("confirm-mapping-summary")).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByTestId("confirm-activate-btn"));

    await waitFor(() =>
      expect(mockConfirmSourceMappingsAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        connectionId: "con_123",
        mappings: [
          {
            sourceRecordType: "custom",
            oxagenEntityType: "task",
            propertyMappings: { id: "externalId" },
          },
        ],
        activateConnection: true,
      }),
    );
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/acme/main/knowledge/sources"),
    );

    // Best-effort integration.configure call using the connector's own
    // declared sync default — see connect-wizard.tsx's handleConfirm.
    expect(mockConfigureSourceIntegrationAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      integrationId: "con_123",
      syncCadence: "polling",
    });
  });

  it("resumes at the Mappings step when a connectionId and saved mappings are supplied", () => {
    render(
      <ConnectSourceWizard
        orgSlug="acme"
        workspaceSlug="main"
        connectors={CONNECTORS}
        initialConnectionId="con_resumed"
        initialMappings={[
          {
            id: "map_1",
            sourceRecordType: "custom",
            oxagenEntityType: "task",
            propertyMappings: {},
            isActive: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("Step 4 of 5")).toBeInTheDocument();
    expect(screen.getByTestId("mapping-row-custom")).toBeInTheDocument();
    expect(mockGetConnectSourceSchemaAction).not.toHaveBeenCalled();
    expect(mockPreviewSourceConnectionAction).not.toHaveBeenCalled();
  });

  it("resumes at the Preview step when a connectionId is supplied with no saved mappings yet", async () => {
    mockPreviewSourceConnectionAction.mockResolvedValue({
      ok: true,
      value: { recordTypes: [] },
    });

    render(
      <ConnectSourceWizard
        orgSlug="acme"
        workspaceSlug="main"
        connectors={CONNECTORS}
        initialConnectionId="con_resumed"
        initialMappings={[]}
      />,
    );

    expect(screen.getByText("Step 3 of 5")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockPreviewSourceConnectionAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        connectionId: "con_resumed",
      }),
    );
  });
});
