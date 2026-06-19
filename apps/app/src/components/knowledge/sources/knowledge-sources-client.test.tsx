// @vitest-environment jsdom
/**
 * knowledge-sources-client.test.tsx — tests the source-row actions wiring.
 *
 * Heavy children (wizard, edit sheet, delete dialog) are mocked to capture the
 * open/target props so we can assert the menu items open the right surface with
 * the right connection.
 */

import * as React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./github-connection-wizard", () => ({
  GitHubConnectionWizard: () => <div data-testid="wizard" />,
}));

vi.mock("./edit-source-config-sheet", () => ({
  EditSourceConfigSheet: ({ open, target }: { open: boolean; target: { publicId: string } | null }) => (
    <div data-testid="edit-sheet" data-open={open ? "true" : "false"} data-target={target?.publicId ?? ""} />
  ),
}));

vi.mock("./delete-source-dialog", () => ({
  DeleteSourceDialog: ({ open, target }: { open: boolean; target: { publicId: string } | null }) => (
    <div data-testid="delete-dialog" data-open={open ? "true" : "false"} data-target={target?.publicId ?? ""} />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...rest}>{children}</button>
  ),
}));

// Menu primitives → render items as plain buttons that fire their onClick.
vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...rest}>{children}</button>
  ),
  MenuSeparator: () => <hr />,
}));

import { KnowledgeSourcesClient } from "./knowledge-sources-client";

const CONNECTION = {
  id: "con_1",
  publicId: "con_pub1",
  connectorId: "github",
  displayName: "Acme Repos",
  authScheme: "oauth2_authorization_code",
  deliveryMethod: "webhook",
  status: "connected",
  entityCount: 42,
  lastSyncAt: null,
  createdAt: "2026-06-18T00:00:00.000Z",
};

const BASE = { orgSlug: "acme", workspaceSlug: "main" };

afterEach(cleanup);

describe("KnowledgeSourcesClient — row actions", () => {
  it("renders a row with edit and delete menu items", () => {
    render(<KnowledgeSourcesClient connections={[CONNECTION]} {...BASE} />);
    expect(screen.getByTestId("connection-row-con_pub1")).toBeTruthy();
    expect(screen.getByTestId("edit-source-con_pub1")).toBeTruthy();
    expect(screen.getByTestId("delete-source-con_pub1")).toBeTruthy();
  });

  it("opens the edit sheet with the selected connection", () => {
    render(<KnowledgeSourcesClient connections={[CONNECTION]} {...BASE} />);
    expect(screen.getByTestId("edit-sheet").getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByTestId("edit-source-con_pub1"));
    const sheet = screen.getByTestId("edit-sheet");
    expect(sheet.getAttribute("data-open")).toBe("true");
    expect(sheet.getAttribute("data-target")).toBe("con_pub1");
  });

  it("opens the delete dialog with the selected connection", () => {
    render(<KnowledgeSourcesClient connections={[CONNECTION]} {...BASE} />);
    expect(screen.getByTestId("delete-dialog").getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByTestId("delete-source-con_pub1"));
    const dialog = screen.getByTestId("delete-dialog");
    expect(dialog.getAttribute("data-open")).toBe("true");
    expect(dialog.getAttribute("data-target")).toBe("con_pub1");
  });

  it("hides deleted connections", () => {
    render(
      <KnowledgeSourcesClient
        connections={[{ ...CONNECTION, status: "deleted" }]}
        {...BASE}
      />,
    );
    expect(screen.queryByTestId("connection-row-con_pub1")).toBeNull();
    expect(screen.getByTestId("connections-empty-state")).toBeTruthy();
  });
});
