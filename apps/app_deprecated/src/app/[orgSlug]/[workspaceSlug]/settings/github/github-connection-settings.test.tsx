// @vitest-environment jsdom
/**
 * github-connection-settings.test.tsx — unit tests for the Workspace Settings →
 * GitHub panel.
 *
 * Covers:
 *   (a) Loading → not-connected state renders the Connect button (canManage)
 *   (b) Connect navigates to the signed identity (OAuth authorize) URL
 *   (c) Not connected + viewer (canManage=false) hides Connect, shows ask-admin
 *   (d) Connected renders each installation + manage/add-org/reconnect controls
 *   (e) Connected + viewer hides add-org/reconnect/configure, keeps manage link
 *   (f) Fetch failure renders the error panel; Retry refetches
 *   (g) ?github_connected=1 shows the success banner and strips the query param
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { GithubConnectionSettings } from "./github-connection-settings";
import type { GithubStatusResponse } from "@/lib/github";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONNECTED: GithubStatusResponse = {
  connected: true,
  installations: [
    {
      id: 101,
      accountLogin: "acme-inc",
      accountType: "Organization",
      repositorySelection: "selected",
      avatarUrl: null,
      htmlUrl:
        "https://github.com/organizations/acme-inc/settings/installations/101",
    },
    {
      id: 202,
      accountLogin: "octocat",
      accountType: "User",
      repositorySelection: "all",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      htmlUrl: null,
    },
  ],
  manageUrl: "https://github.com/apps/oxagen/installations/new",
  identityUrl: "https://github.com/login/oauth/authorize?state=signed",
  installUrl: "https://github.com/apps/oxagen/installations/new?state=signed",
};

const DISCONNECTED: GithubStatusResponse = {
  connected: false,
  installations: [],
  manageUrl: "https://github.com/apps/oxagen/installations/new",
  identityUrl: "https://github.com/login/oauth/authorize?state=signed",
  installUrl: "https://github.com/apps/oxagen/installations/new?state=signed",
};

function mockFetchOnceOk(status: GithubStatusResponse): void {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => status,
  });
}

function renderPanel(canManage: boolean) {
  return render(
    <GithubConnectionSettings
      orgSlug="acme"
      workspaceSlug="main"
      canManage={canManage}
    />,
  );
}

beforeEach(() => {
  global.fetch = vi.fn();
  // jsdom: replace location so href assignment + search/pathname reads are safe.
  delete (window as { location?: unknown }).location;
  (
    window as { location: { href: string; search: string; pathname: string } }
  ).location = {
    href: "",
    search: "",
    pathname: "/acme/main/settings/github",
  };
  window.history.replaceState = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GithubConnectionSettings", () => {
  it("renders the Connect button when GitHub is not connected and the viewer can manage", async () => {
    mockFetchOnceOk(DISCONNECTED);
    renderPanel(true);

    await waitFor(() =>
      expect(screen.getByTestId("github-disconnected")).toBeTruthy(),
    );
    expect(screen.getByTestId("github-connect-btn")).toBeTruthy();
    // The status endpoint was hit once.
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/acme/main/connections/github/status",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("navigates to the signed identity (OAuth authorize) URL when Connect is clicked", async () => {
    mockFetchOnceOk(DISCONNECTED);
    renderPanel(true);

    await waitFor(() =>
      expect(screen.getByTestId("github-connect-btn")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("github-connect-btn"));
    // The identity leg is the primary connect destination (lets a second tenant
    // establish its own token), NOT the install URL.
    expect(window.location.href).toBe(DISCONNECTED.identityUrl);
    expect(window.location.href).not.toBe(DISCONNECTED.installUrl);
  });

  it("hides Connect and tells viewers to ask an admin when not connected", async () => {
    mockFetchOnceOk(DISCONNECTED);
    renderPanel(false);

    await waitFor(() =>
      expect(screen.getByTestId("github-disconnected")).toBeTruthy(),
    );
    expect(screen.queryByTestId("github-connect-btn")).toBeNull();
    expect(screen.getByText(/ask a workspace owner or admin/i)).toBeTruthy();
  });

  it("renders each installation and the manage controls when connected", async () => {
    mockFetchOnceOk(CONNECTED);
    renderPanel(true);

    await waitFor(() =>
      expect(screen.getByTestId("github-connected")).toBeTruthy(),
    );
    expect(screen.getByText("acme-inc")).toBeTruthy();
    expect(screen.getByText("octocat")).toBeTruthy();
    expect(screen.getByTestId("github-add-org-link")).toBeTruthy();
    expect(screen.getByTestId("github-manage-link")).toBeTruthy();
    expect(screen.getByTestId("github-reconnect-btn")).toBeTruthy();
    // The first install carries an htmlUrl → a Configure link; the second does not.
    expect(screen.getByTestId("github-configure-101")).toBeTruthy();
    expect(screen.queryByTestId("github-configure-202")).toBeNull();
  });

  it("hides manager-only controls for viewers but keeps the manage link", async () => {
    mockFetchOnceOk(CONNECTED);
    renderPanel(false);

    await waitFor(() =>
      expect(screen.getByTestId("github-connected")).toBeTruthy(),
    );
    expect(screen.queryByTestId("github-add-org-link")).toBeNull();
    expect(screen.queryByTestId("github-reconnect-btn")).toBeNull();
    expect(screen.queryByTestId("github-configure-101")).toBeNull();
    expect(screen.getByTestId("github-manage-link")).toBeTruthy();
  });

  it("renders an error panel on fetch failure and retries on demand", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({
        error: "GitHub API returned 502 when listing installations",
      }),
    });
    renderPanel(true);

    await waitFor(() =>
      expect(screen.getByTestId("github-settings-error")).toBeTruthy(),
    );
    expect(screen.getByText(/502/)).toBeTruthy();

    // Retry → second fetch succeeds and the connected view renders.
    mockFetchOnceOk(CONNECTED);
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() =>
      expect(screen.getByTestId("github-connected")).toBeTruthy(),
    );
  });

  it("shows the success banner and strips the query param after returning from install", async () => {
    (window as { location: { search: string } }).location.search =
      "?github_connected=1";
    mockFetchOnceOk(CONNECTED);
    renderPanel(true);

    await waitFor(() =>
      expect(screen.getByTestId("github-connected-banner")).toBeTruthy(),
    );
    expect(window.history.replaceState).toHaveBeenCalled();
  });
});
