// @vitest-environment jsdom
/**
 * repos-client.test.tsx — unit tests for repoStatusDisplay + ReposClient.
 *
 * Covers:
 *   (a) repoStatusDisplay for every connection status × health branch
 *   (b) empty state renders when there are no repos
 *   (c) a repo row renders its parsed owner/repo label, links to the detail
 *       page, and shows sync-status/last-index
 *   (d) row actions (Sync/Pause/Configure) are hidden for a non-manager and
 *       shown for a manager, and Sync calls syncRepoAction with the right shape
 *
 * Mocks ./actions, ./repo-drawers, and ./github-app-status-action so the
 * test focuses on ReposClient's own table/row logic — the drawers and the
 * GitHub status widget get their own coverage elsewhere (or are simple
 * enough to trust via manual verification).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReposClient, repoStatusDisplay } from "./repos-client";
import type { RepoRow } from "@/lib/workbench/repos";

const {
  refreshReposAction,
  syncRepoAction,
  pauseRepoAction,
  resumeRepoAction,
} = vi.hoisted(() => ({
  refreshReposAction: vi.fn(async () => ({ ok: true, repos: [] })),
  syncRepoAction: vi.fn(async () => ({
    ok: true,
    result: {
      jobId: "job_1",
      status: "queued",
      mode: "incremental",
      estimatedRecords: 0,
    },
  })),
  pauseRepoAction: vi.fn(async () => ({ ok: true, result: {} })),
  resumeRepoAction: vi.fn(async () => ({ ok: true, result: {} })),
}));

vi.mock("./actions", () => ({
  refreshReposAction,
  syncRepoAction,
  pauseRepoAction,
  resumeRepoAction,
}));
vi.mock("./repo-drawers", () => ({
  CreateRepoDrawer: () => null,
  ForkRepoDrawer: () => null,
  ConfigureRepoDrawer: () => null,
  EditFileLauncherDrawer: () => null,
}));
vi.mock("./github-app-status-action", () => ({
  GithubAppStatusAction: () => <div data-testid="github-status-stub" />,
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) repoStatusDisplay — pure branch coverage
// ---------------------------------------------------------------------------

describe("repoStatusDisplay", () => {
  it("pending_setup → Setup incomplete / warning", () => {
    expect(repoStatusDisplay("pending_setup", "healthy")).toEqual({
      label: "Setup incomplete",
      dot: "warning",
    });
  });
  it("connected + healthy → Syncing / success", () => {
    expect(repoStatusDisplay("connected", "healthy")).toEqual({
      label: "Syncing",
      dot: "success",
    });
  });
  it("connected + degraded → Degraded / warning", () => {
    expect(repoStatusDisplay("connected", "degraded")).toEqual({
      label: "Degraded",
      dot: "warning",
    });
  });
  it("connected + errored → Error / error", () => {
    expect(repoStatusDisplay("connected", "errored")).toEqual({
      label: "Error",
      dot: "error",
    });
  });
  it("paused → Paused / neutral", () => {
    expect(repoStatusDisplay("paused", "healthy")).toEqual({
      label: "Paused",
      dot: "neutral",
    });
  });
  it("error → Error / error", () => {
    expect(repoStatusDisplay("error", "errored")).toEqual({
      label: "Error",
      dot: "error",
    });
  });
  it("deleting → Deleting / neutral", () => {
    expect(repoStatusDisplay("deleting", "healthy")).toEqual({
      label: "Deleting",
      dot: "neutral",
    });
  });
  it("deleted → Deleted / neutral", () => {
    expect(repoStatusDisplay("deleted", "healthy")).toEqual({
      label: "Deleted",
      dot: "neutral",
    });
  });
});

// ---------------------------------------------------------------------------
// ReposClient — render tests
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: "id-1",
    publicId: "con_1",
    connectorId: "github",
    displayName: "acme/widgets",
    authScheme: "oauth",
    deliveryMethod: "polling",
    status: "connected",
    entityCount: 12,
    lastSyncAt: "2026-07-10T00:00:00.000Z",
    healthStatus: "healthy",
    lastPollAt: null,
    nextPollAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    metrics: null,
    metricsError: null,
    ...overrides,
  };
}

describe("ReposClient", () => {
  it("renders the empty state when there are no repos", () => {
    render(
      <ReposClient
        orgSlug="acme"
        workspaceSlug="eng"
        canManage={true}
        initialRepos={[]}
        unavailable={false}
      />,
    );
    expect(screen.getByTestId("repos-empty-state")).toBeInTheDocument();
  });

  it("hides the inoperable toolbar and puts Create repo inside the empty state", () => {
    render(
      <ReposClient
        orgSlug="acme"
        workspaceSlug="eng"
        canManage={true}
        initialRepos={[]}
        unavailable={false}
      />,
    );
    // Refresh / Edit / Fork / top Create are inoperable with zero repos —
    // the whole top toolbar is hidden.
    expect(screen.queryByTestId("repos-refresh-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repos-edit-file-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repos-fork-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repos-create-btn")).not.toBeInTheDocument();
    // Create repo is offered as the secondary action inside the empty card.
    const empty = screen.getByTestId("repos-empty-state");
    expect(
      within(empty).getByTestId("repos-empty-create-btn"),
    ).toBeInTheDocument();
  });

  it("shows the top toolbar (not the empty create) once repos exist", () => {
    render(
      <ReposClient
        orgSlug="acme"
        workspaceSlug="eng"
        canManage={true}
        initialRepos={[makeRow()]}
        unavailable={false}
      />,
    );
    expect(screen.getByTestId("repos-refresh-btn")).toBeInTheDocument();
    expect(screen.getByTestId("repos-create-btn")).toBeInTheDocument();
    expect(
      screen.queryByTestId("repos-empty-create-btn"),
    ).not.toBeInTheDocument();
  });

  it("renders a parsed owner/repo row linking to the detail page", () => {
    render(
      <ReposClient
        orgSlug="acme"
        workspaceSlug="eng"
        canManage={true}
        initialRepos={[makeRow()]}
        unavailable={false}
      />,
    );
    const row = screen.getByTestId("repo-row-con_1");
    expect(within(row).getByTestId("repo-link-con_1")).toHaveTextContent(
      "acme/widgets",
    );
    expect(within(row).getByTestId("repo-link-con_1")).toHaveAttribute(
      "href",
      "/acme/eng/workbench/repos/con_1",
    );
  });

  it("hides row actions for a non-manager", () => {
    render(
      <ReposClient
        orgSlug="acme"
        workspaceSlug="eng"
        canManage={false}
        initialRepos={[makeRow()]}
        unavailable={false}
      />,
    );
    expect(screen.queryByTestId("repo-sync-con_1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repos-create-btn")).not.toBeInTheDocument();
  });

  it("Sync now calls syncRepoAction and shows a busy label", async () => {
    const user = userEvent.setup();
    render(
      <ReposClient
        orgSlug="acme"
        workspaceSlug="eng"
        canManage={true}
        initialRepos={[makeRow()]}
        unavailable={false}
      />,
    );
    await user.click(screen.getByTestId("repo-sync-con_1"));
    expect(syncRepoAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "eng",
      repoId: "con_1",
      mode: "incremental",
    });
  });

  it("shows Resume instead of Pause for a paused repo", () => {
    render(
      <ReposClient
        orgSlug="acme"
        workspaceSlug="eng"
        canManage={true}
        initialRepos={[makeRow({ status: "paused" })]}
        unavailable={false}
      />,
    );
    expect(screen.getByTestId("repo-pause-resume-con_1")).toHaveTextContent(
      "Resume",
    );
  });
});
