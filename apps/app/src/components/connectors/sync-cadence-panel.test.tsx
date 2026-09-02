// @vitest-environment jsdom
/**
 * sync-cadence-panel.test.tsx — Unit tests for SyncCadencePanel.
 */

import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { ConnectorSchemaProvider } from "./connector-schema-provider";
import { SyncCadencePanel } from "./sync-cadence-panel";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

const WEBHOOK_POLLING_SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "test",
    displayName: "Test",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  sync: {
    delivery: "webhook",
    pollingSupported: true,
    polling: {
      defaultIntervalSeconds: 300,
      minIntervalSeconds: 60,
    },
  },
};

const POLLING_ONLY_SCHEMA: ConnectorPluginSchema = {
  ...WEBHOOK_POLLING_SCHEMA,
  sync: {
    delivery: "polling",
    pollingSupported: true,
    polling: {
      defaultIntervalSeconds: 900,
      minIntervalSeconds: 300,
    },
  },
};

const MANUAL_ONLY_SCHEMA: ConnectorPluginSchema = {
  ...WEBHOOK_POLLING_SCHEMA,
  sync: {
    delivery: "manual",
    pollingSupported: false,
  },
};

const NO_SYNC_SCHEMA: ConnectorPluginSchema = {
  ...WEBHOOK_POLLING_SCHEMA,
  sync: undefined,
};

function renderPanel(schema: ConnectorPluginSchema) {
  return render(
    <ConnectorSchemaProvider
      pluginId="test"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <SyncCadencePanel />
    </ConnectorSchemaProvider>,
  );
}

describe("SyncCadencePanel — no sync schema", () => {
  it("renders nothing when no sync defined", () => {
    const { container } = renderPanel(NO_SYNC_SCHEMA);
    expect(container.firstChild).toBeNull();
  });
});

describe("SyncCadencePanel — manual only (single option)", () => {
  it("renders nothing when only one delivery option", () => {
    const { container } = renderPanel(MANUAL_ONLY_SCHEMA);
    // Only "manual" option exists → less than 2 options → nothing rendered
    expect(container.firstChild).toBeNull();
  });
});

describe("SyncCadencePanel — webhook + polling", () => {
  it("renders sync cadence heading", () => {
    renderPanel(WEBHOOK_POLLING_SCHEMA);
    expect(screen.getByText("Sync cadence")).toBeInTheDocument();
  });

  it("renders webhook, polling, and manual options", () => {
    renderPanel(WEBHOOK_POLLING_SCHEMA);
    expect(screen.getByText(/Real-time/i)).toBeInTheDocument();
    expect(screen.getByText(/Scheduled polling/i)).toBeInTheDocument();
    expect(screen.getByText(/Manual only/i)).toBeInTheDocument();
  });

  it("renders radio buttons for each mode", () => {
    renderPanel(WEBHOOK_POLLING_SCHEMA);
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThanOrEqual(3);
  });

  it("does not show polling interval input for webhook mode by default", () => {
    renderPanel(WEBHOOK_POLLING_SCHEMA);
    expect(screen.queryByLabelText("Polling interval")).not.toBeInTheDocument();
  });

  it("shows polling interval input when polling is selected", async () => {
    renderPanel(WEBHOOK_POLLING_SCHEMA);
    const pollingRadio = screen.getByRole("radio", {
      name: /scheduled polling/i,
    });
    await userEvent.click(pollingRadio);
    expect(screen.getByLabelText("Polling interval")).toBeInTheDocument();
  });

  it("shows default polling interval value", async () => {
    renderPanel(WEBHOOK_POLLING_SCHEMA);
    const pollingRadio = screen.getByRole("radio", {
      name: /scheduled polling/i,
    });
    await userEvent.click(pollingRadio);
    const intervalInput = screen.getByLabelText("Polling interval");
    expect(intervalInput).toHaveValue(300);
  });
});

describe("SyncCadencePanel — polling only", () => {
  it("renders polling and manual options", () => {
    renderPanel(POLLING_ONLY_SCHEMA);
    expect(screen.getByText(/Scheduled polling/i)).toBeInTheDocument();
    expect(screen.getByText(/Manual only/i)).toBeInTheDocument();
  });

  it("shows polling interval by default when polling is default mode", async () => {
    renderPanel(POLLING_ONLY_SCHEMA);
    // Polling is the default selection
    expect(screen.getByLabelText("Polling interval")).toBeInTheDocument();
  });

  it("shows min/max hint", () => {
    renderPanel(POLLING_ONLY_SCHEMA);
    // Min hint text should appear
    expect(screen.getByText(/Min:/i)).toBeInTheDocument();
  });
});

describe("SyncCadencePanel — interval validation", () => {
  it("shows error when interval is below minimum", () => {
    renderPanel(POLLING_ONLY_SCHEMA);
    const intervalInput = screen.getByLabelText("Polling interval");
    // Directly fire a change event with a value below the minimum
    fireEvent.change(intervalInput, { target: { value: "10" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/minimum is 300s/i);
  });

  it("shows error when interval is above maximum", () => {
    renderPanel(POLLING_ONLY_SCHEMA);
    const intervalInput = screen.getByLabelText("Polling interval");
    fireEvent.change(intervalInput, { target: { value: "999999" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/maximum is/i);
  });

  it("shows error when interval is non-numeric", () => {
    renderPanel(POLLING_ONLY_SCHEMA);
    const intervalInput = screen.getByLabelText("Polling interval");
    fireEvent.change(intervalInput, { target: { value: "abc" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/must be a number/i);
  });

  it("clears error when valid interval is entered", () => {
    renderPanel(POLLING_ONLY_SCHEMA);
    const intervalInput = screen.getByLabelText("Polling interval");
    // First set an invalid value
    fireEvent.change(intervalInput, { target: { value: "10" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Then set a valid value
    fireEvent.change(intervalInput, { target: { value: "600" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
