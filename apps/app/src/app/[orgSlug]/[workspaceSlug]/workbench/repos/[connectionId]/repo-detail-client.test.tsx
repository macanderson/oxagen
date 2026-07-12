// @vitest-environment jsdom
/**
 * repo-detail-client.test.tsx — unit tests for the repo detail tab shell.
 *
 * Covers: the default tab is Overview, a deep-linked `initialTab` (from the
 * list page's ?tab=pulls) opens directly on that tab, and clicking a tab
 * switches the rendered panel. Every tab body is mocked to a stub so this
 * test stays about tab-switching, not each tab's own data logic (which has
 * its own coverage where practical).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoDetailClient } from "./repo-detail-client";
import type { RepoConnection } from "@/lib/workbench/repos";

vi.mock("./overview-tab", () => ({
  OverviewTab: () => <div data-testid="stub-overview" />,
}));
vi.mock("./branches-tab", () => ({
  BranchesTab: () => <div data-testid="stub-branches" />,
}));
vi.mock("./pull-requests-tab", () => ({
  PullRequestsTab: () => <div data-testid="stub-pulls" />,
}));
vi.mock("./files-tab", () => ({
  FilesTab: () => <div data-testid="stub-files" />,
}));
vi.mock("./locks-tab", () => ({
  LocksTab: () => <div data-testid="stub-locks" />,
}));

afterEach(() => {
  cleanup();
});

const CONNECTION: RepoConnection = {
  id: "id-1",
  publicId: "con_1",
  connectorId: "github",
  displayName: "acme/widgets",
  authScheme: "oauth",
  deliveryMethod: "polling",
  status: "connected",
  entityCount: 5,
  lastSyncAt: null,
  healthStatus: "healthy",
  lastPollAt: null,
  nextPollAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

function renderClient(
  initialTab:
    | "overview"
    | "branches"
    | "pulls"
    | "files"
    | "locks" = "overview",
) {
  return render(
    <RepoDetailClient
      orgSlug="acme"
      workspaceSlug="eng"
      connection={CONNECTION}
      slug={{ owner: "acme", repo: "widgets" }}
      initialMetrics={null}
      canManage={true}
      initialTab={initialTab}
    />,
  );
}

describe("RepoDetailClient", () => {
  it("defaults to the Overview tab", () => {
    renderClient();
    expect(screen.getByTestId("stub-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-pulls")).not.toBeInTheDocument();
  });

  it("honors a deep-linked initialTab (list page's ?tab=pulls)", () => {
    renderClient("pulls");
    expect(screen.getByTestId("stub-pulls")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-overview")).not.toBeInTheDocument();
  });

  it("switches panels when a tab is clicked", async () => {
    const user = userEvent.setup();
    renderClient();
    await user.click(screen.getByTestId("repo-tab-locks"));
    expect(screen.getByTestId("stub-locks")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-overview")).not.toBeInTheDocument();
  });
});
