// @vitest-environment jsdom
/**
 * knowledge-sources-client.test.tsx — tests the source-row actions wiring.
 *
 * Heavy children (wizard, edit sheet, delete dialog) are mocked to capture the
 * open/target props so we can assert the menu items open the right surface with
 * the right connection.
 *
 * Gate / wizard-internal behavior (not-connected → install gate, connected →
 * repo selector) is covered in github-connection-wizard.test.tsx where the
 * real wizard renders without the module-level mock below.
 */

import * as React from "react";

// Silence any `@/lib/github` import from the real wizard (mocked out below)
// and from any future tests that render wizard internals.
vi.mock("@/lib/github", () => ({
  fetchGithubStatus: vi.fn(),
  API_BASE: "/api",
}));
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("./github-connection-wizard", () => ({
  GitHubConnectionWizard: ({
    open,
    initialConnectionId,
  }: {
    open: boolean;
    initialConnectionId?: string;
  }) => (
    <div
      data-testid="wizard"
      data-open={open ? "true" : "false"}
      data-initial-connection-id={initialConnectionId ?? ""}
    />
  ),
}));

vi.mock("./edit-source-config-sheet", () => ({
  EditSourceConfigSheet: ({
    open,
    target,
  }: {
    open: boolean;
    target: { publicId: string } | null;
  }) => (
    <div
      data-testid="edit-sheet"
      data-open={open ? "true" : "false"}
      data-target={target?.publicId ?? ""}
    />
  ),
}));

vi.mock("./delete-source-dialog", () => ({
  DeleteSourceDialog: ({
    open,
    target,
  }: {
    open: boolean;
    target: { publicId: string } | null;
  }) => (
    <div
      data-testid="delete-dialog"
      data-open={open ? "true" : "false"}
      data-target={target?.publicId ?? ""}
    />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));

// Menu primitives → render items as plain buttons that fire their onClick.
vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MenuItem: ({
    children,
    onClick,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
  MenuSeparator: () => <hr />,
}));

import { KnowledgeConnectionsClient } from "./knowledge-connections-client";
import {
  storePendingGithubConnection,
  readPendingGithubConnection,
} from "./github-connection-wizard-types";

const CONNECTION = {
  id: "con_1",
  publicId: "con_pub1",
  connectorId: "github",
  displayName: "Acme Repos",
  authScheme: "oauth2_authorization_code",
  deliveryMethod: "webhook",
  status: "connected",
  healthStatus: "healthy" as const,
  entityCount: 42,
  lastSyncAt: null,
  lastPollAt: null,
  nextPollAt: null,
  createdAt: "2026-06-18T00:00:00.000Z",
};

const BASE = { orgSlug: "acme", workspaceSlug: "main" };

afterEach(cleanup);

describe("KnowledgeConnectionsClient — row actions", () => {
  it("renders a row with edit and delete menu items", () => {
    render(<KnowledgeConnectionsClient connections={[CONNECTION]} {...BASE} />);
    expect(screen.getByTestId("connection-row-con_pub1")).toBeTruthy();
    expect(screen.getByTestId("edit-source-con_pub1")).toBeTruthy();
    expect(screen.getByTestId("delete-source-con_pub1")).toBeTruthy();
  });

  it("opens the edit sheet with the selected connection", () => {
    render(<KnowledgeConnectionsClient connections={[CONNECTION]} {...BASE} />);
    expect(screen.getByTestId("edit-sheet").getAttribute("data-open")).toBe(
      "false",
    );
    fireEvent.click(screen.getByTestId("edit-source-con_pub1"));
    const sheet = screen.getByTestId("edit-sheet");
    expect(sheet.getAttribute("data-open")).toBe("true");
    expect(sheet.getAttribute("data-target")).toBe("con_pub1");
  });

  it("opens the delete dialog with the selected connection", () => {
    render(<KnowledgeConnectionsClient connections={[CONNECTION]} {...BASE} />);
    expect(screen.getByTestId("delete-dialog").getAttribute("data-open")).toBe(
      "false",
    );
    fireEvent.click(screen.getByTestId("delete-source-con_pub1"));
    const dialog = screen.getByTestId("delete-dialog");
    expect(dialog.getAttribute("data-open")).toBe("true");
    expect(dialog.getAttribute("data-target")).toBe("con_pub1");
  });

  it("hides deleted connections", () => {
    render(
      <KnowledgeConnectionsClient
        connections={[{ ...CONNECTION, status: "deleted" }]}
        {...BASE}
      />,
    );
    expect(screen.queryByTestId("connection-row-con_pub1")).toBeNull();
    expect(screen.getByTestId("connections-empty-state")).toBeTruthy();
  });
});

describe("KnowledgeConnectionsClient — GitHub wizard resume after redirect", () => {
  let replaceSpy: ReturnType<typeof vi.fn>;
  const realLocation = window.location;

  beforeEach(() => {
    window.sessionStorage.clear();
    replaceSpy = vi.fn();
    // jsdom's location.replace isn't directly redefinable; swap the whole
    // location object (same pattern as the Step 1 redirect test).
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        replace: replaceSpy,
        assign: vi.fn(),
        href: "http://localhost/",
        pathname: "/",
        search: "",
      },
    });
  });

  afterEach(() => {
    window.sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("resumes Step 2 with the stored connection id when the redirect dropped it (Setup-URL leg)", async () => {
    // GitHub's stateless update leg lands on `…/sources?setup=github` with no
    // connectionId; the handoff stored before leaving for GitHub recovers it.
    storePendingGithubConnection({
      connectionId: "con_PENDING",
      orgSlug: "acme",
      workspaceSlug: "main",
    });

    render(
      <KnowledgeConnectionsClient
        connections={[]}
        {...BASE}
        setupConnector="github"
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("wizard").getAttribute("data-initial-connection-id"),
      ).toBe("con_PENDING"),
    );
    expect(screen.getByTestId("wizard").getAttribute("data-open")).toBe("true");
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("prefers the URL connection id and clears the stale handoff (OAuth-callback leg)", async () => {
    storePendingGithubConnection({
      connectionId: "con_STALE",
      orgSlug: "acme",
      workspaceSlug: "main",
    });

    render(
      <KnowledgeConnectionsClient
        connections={[]}
        {...BASE}
        setupConnector="github"
        setupConnectionId="con_URL"
      />,
    );

    expect(
      screen.getByTestId("wizard").getAttribute("data-initial-connection-id"),
    ).toBe("con_URL");
    await waitFor(() => expect(readPendingGithubConnection()).toBeNull());
  });

  it("self-corrects to the originating workspace when the redirect landed elsewhere", async () => {
    // Connect started in workspace "research" but the stateless leg resolved to "main".
    storePendingGithubConnection({
      connectionId: "con_X",
      orgSlug: "acme",
      workspaceSlug: "research",
    });

    render(
      <KnowledgeConnectionsClient
        connections={[]}
        {...BASE}
        setupConnector="github"
      />,
    );

    await waitFor(() =>
      expect(replaceSpy).toHaveBeenCalledWith(
        "/acme/research/knowledge/sources?setup=github",
      ),
    );
  });

  it("leaves the wizard at Step 1 when there is no handoff and no URL id", () => {
    render(
      <KnowledgeConnectionsClient
        connections={[]}
        {...BASE}
        setupConnector="github"
      />,
    );
    expect(
      screen.getByTestId("wizard").getAttribute("data-initial-connection-id"),
    ).toBe("");
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
