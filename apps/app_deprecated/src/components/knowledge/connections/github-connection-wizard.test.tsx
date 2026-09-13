// @vitest-environment jsdom
/**
 * github-connection-wizard.test.tsx — tests for the gate + connected flows in
 * the wizard orchestrator.
 *
 * Covers:
 *   - Not connected: fetchGithubStatus returns { connected: false } → renders
 *     GitHubInstallGate (data-testid="github-install-gate").
 *   - Connected: fetchGithubStatus returns { connected: true } → creates a
 *     pending connection via POST and advances to the repo selector
 *     (data-testid="step2-select-repos").
 *   - With initialConnectionId (OAuth / settings redirect-return): skips the
 *     gate entirely and starts at select-repos; fetchGithubStatus is never called.
 *   - Error: status fetch rejects → renders an error with a retry button that
 *     re-triggers the check.
 */

/// <reference types="@testing-library/jest-dom" />

import * as React from "react";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GitHubConnectionWizard } from "./github-connection-wizard";
import { fetchGithubStatus } from "@/lib/github";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/github", () => ({
  fetchGithubStatus: vi.fn(),
  API_BASE: "/api",
}));

vi.mock("@oxagen/ui", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (v: boolean) => void;
    children: React.ReactNode;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Step2 / Step3 / success mocked to keep the gate logic isolated — their own
// test files cover each component in depth.
vi.mock("./github-connection-wizard-step2", () => ({
  Step2SelectRepos: () => <div data-testid="step2-select-repos" />,
}));

vi.mock("./github-connection-wizard-step3", () => ({
  Step3Confirm: () => <div data-testid="step3-confirm" />,
}));

vi.mock("./github-connection-wizard-success", () => ({
  SuccessState: () => <div data-testid="success-state" />,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG = "acme";
const WS = "main";

const STATUS_NOT_CONNECTED = {
  connected: false,
  installations: [],
  manageUrl: "",
  identityUrl: "",
  installUrl: "",
};

const STATUS_CONNECTED = {
  connected: true,
  installations: [],
  manageUrl: "",
  identityUrl: "",
  installUrl: "",
};

type FetchJson = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

/** Returns a fetch mock that handles the connection-create POST. */
function makeDefaultFetch(connectionPublicId = "con_NEW"): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL): Promise<FetchJson> => {
    const url = String(input);
    // Only the connection-create POST should reach fetch in these tests.
    if (url.includes("/connections")) {
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({ publicId: connectionPublicId }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const mockFetchStatus = fetchGithubStatus as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  global.fetch = makeDefaultFetch();
});

afterEach(cleanup);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GitHubConnectionWizard — gate: not connected", () => {
  it("shows the install gate when the workspace GitHub App is not installed", async () => {
    mockFetchStatus.mockResolvedValueOnce(STATUS_NOT_CONNECTED);

    render(
      <GitHubConnectionWizard
        open
        orgSlug={ORG}
        workspaceSlug={WS}
        onClose={vi.fn()}
      />,
    );

    // Spinner shows while the check runs, then the gate panel appears.
    await screen.findByTestId("github-install-gate");
    expect(screen.queryByTestId("step2-select-repos")).toBeNull();
    // No connection POST should have been made.
    expect(
      (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    ).toHaveLength(0);
  });
});

describe("GitHubConnectionWizard — gate: connected", () => {
  it("creates a connection and advances to the repo selector when connected", async () => {
    mockFetchStatus.mockResolvedValueOnce(STATUS_CONNECTED);

    render(
      <GitHubConnectionWizard
        open
        orgSlug={ORG}
        workspaceSlug={WS}
        onClose={vi.fn()}
      />,
    );

    // After the status check + connection create, step2 should be visible.
    await screen.findByTestId("step2-select-repos");
    expect(screen.queryByTestId("github-install-gate")).toBeNull();

    // The connection-create POST must have fired.
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const createCall = calls.find(([url]) =>
      String(url).includes("/connections"),
    );
    expect(createCall).toBeDefined();
  });
});

describe("GitHubConnectionWizard — gate: error + retry", () => {
  it("shows an error panel and retries on button click", async () => {
    // First call throws, second returns not-connected.
    mockFetchStatus
      .mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce(STATUS_NOT_CONNECTED);

    render(
      <GitHubConnectionWizard
        open
        orgSlug={ORG}
        workspaceSlug={WS}
        onClose={vi.fn()}
      />,
    );

    // Error panel with retry button should appear.
    const retryBtn = await screen.findByTestId("github-gate-retry-btn");
    expect(screen.getByText(/Network failure/)).toBeInTheDocument();

    // Retry → second fetch → not-connected → gate.
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await screen.findByTestId("github-install-gate");
    expect(mockFetchStatus).toHaveBeenCalledTimes(2);
  });
});

describe("GitHubConnectionWizard — initialConnectionId (OAuth return)", () => {
  it("skips the gate and starts at select-repos when a connectionId is provided", async () => {
    render(
      <GitHubConnectionWizard
        open
        orgSlug={ORG}
        workspaceSlug={WS}
        onClose={vi.fn()}
        initialConnectionId="con_EXISTING"
      />,
    );

    // fetchGithubStatus must NOT be called — the OAuth return already has a connection.
    expect(mockFetchStatus).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("step2-select-repos")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("github-install-gate")).toBeNull();
  });
});
