// @vitest-environment jsdom
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { ConnectorPickerStep } from "./connector-picker-step";
import type { ConnectorCatalogEntry } from "./wizard-types";

afterEach(cleanup);

const CONNECTORS: ConnectorCatalogEntry[] = [
  {
    connectorId: "custom-sql",
    displayName: "Custom SQL",
    description: "Sync records from any relational database.",
    icon: "database",
    isOAuthOnly: false,
  },
  {
    connectorId: "google-drive",
    displayName: "Google Drive",
    description: "Sync files from Google Drive.",
    icon: "globe",
    isOAuthOnly: true,
  },
  {
    connectorId: "github",
    displayName: "GitHub",
    description: "Sync repos from GitHub.",
    icon: "globe",
    isOAuthOnly: true,
  },
];

describe("ConnectorPickerStep", () => {
  it("renders a card per connector", () => {
    render(
      <ConnectorPickerStep
        orgSlug="acme"
        workspaceSlug="main"
        connectors={CONNECTORS}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("connector-card-custom-sql")).toBeInTheDocument();
    expect(
      screen.getByTestId("connector-card-google-drive"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("connector-card-github")).toBeInTheDocument();
  });

  it("calls onSelect for a non-OAuth connector", () => {
    const onSelect = vi.fn();
    render(
      <ConnectorPickerStep
        orgSlug="acme"
        workspaceSlug="main"
        connectors={CONNECTORS}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("connector-select-custom-sql"));
    expect(onSelect).toHaveBeenCalledWith(CONNECTORS[0]);
  });

  it("shows a redirect-out notice instead of calling onSelect for an OAuth-only connector", () => {
    const onSelect = vi.fn();
    render(
      <ConnectorPickerStep
        orgSlug="acme"
        workspaceSlug="main"
        connectors={CONNECTORS}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("connector-select-google-drive"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId("oauth-redirect-notice")).toBeInTheDocument();
    const link = screen.getByTestId("oauth-redirect-link");
    expect(link).toHaveAttribute(
      "href",
      "/acme/main/marketplace/integrations/google-drive",
    );
  });

  it("routes GitHub's OAuth notice to the Sources ?setup=github flow", () => {
    render(
      <ConnectorPickerStep
        orgSlug="acme"
        workspaceSlug="main"
        connectors={CONNECTORS}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("connector-select-github"));
    const link = screen.getByTestId("oauth-redirect-link");
    expect(link).toHaveAttribute(
      "href",
      "/acme/main/knowledge/sources?setup=github",
    );
  });

  it("renders an empty state when there are no connectors", () => {
    render(
      <ConnectorPickerStep
        orgSlug="acme"
        workspaceSlug="main"
        connectors={[]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("No connectors available")).toBeInTheDocument();
  });
});
