// @vitest-environment jsdom
/**
 * overview-tab.test.tsx — unit tests for OverviewTab.
 *
 * Covers all four render branches — error+retry (no metrics, not loading),
 * loading (retry in flight), the no-slug empty state (metrics loaded but the
 * connection hasn't resolved an owner/repo), and the zero-entity CTA — plus
 * a successful refetch transitioning error -> normal stats.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewTab } from "./overview-tab";
import type { RepoMetrics } from "@/lib/workbench/repos";

const { getRepoMetricsAction } = vi.hoisted(() => ({
  getRepoMetricsAction: vi.fn(),
}));

vi.mock("../actions", () => ({ getRepoMetricsAction }));

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const SLUG = { owner: "acme", repo: "widgets" };

function makeMetrics(overrides: Partial<RepoMetrics> = {}): RepoMetrics {
  return {
    entityCount: 42,
    status: "connected",
    lastSyncAt: "2026-07-10T00:00:00.000Z",
    estimatedNextSyncAt: "2026-07-12T00:00:00.000Z",
    syncIntervalSeconds: 300,
    errorMessage: null,
    ...overrides,
  } as RepoMetrics;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OverviewTab", () => {
  it("error+retry: renders ErrorState when there are no initial metrics", () => {
    render(
      <OverviewTab
        scope={SCOPE}
        connectionId="con_1"
        initialMetrics={null}
        slug={SLUG}
        onNavigateToBranches={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load repo metrics");
    expect(alert).toHaveTextContent(
      "We couldn't read sync metrics for this repo connection. Try again.",
    );
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("repo-overview-tab")).not.toBeInTheDocument();
  });

  it("loading: shows the pulse skeleton while a retry is in flight", async () => {
    let resolveRetry!: (value: { ok: true; metrics: RepoMetrics }) => void;
    getRepoMetricsAction.mockReturnValue(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    const user = userEvent.setup();
    const { container } = render(
      <OverviewTab
        scope={SCOPE}
        connectionId="con_1"
        initialMetrics={null}
        slug={SLUG}
        onNavigateToBranches={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    // While the retry promise is pending, metrics is still null but loading
    // is true — the component renders the pulse skeleton, not ErrorState.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();

    resolveRetry({ ok: true, metrics: makeMetrics() });
    await waitFor(() =>
      expect(screen.getByTestId("repo-overview-tab")).toBeInTheDocument(),
    );
  });

  it("retry success replaces the error state with the loaded stats", async () => {
    getRepoMetricsAction.mockResolvedValue({
      ok: true,
      metrics: makeMetrics({ entityCount: 7 }),
    });
    const user = userEvent.setup();
    render(
      <OverviewTab
        scope={SCOPE}
        connectionId="con_1"
        initialMetrics={null}
        slug={SLUG}
        onNavigateToBranches={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    const tab = await screen.findByTestId("repo-overview-tab");
    expect(tab).toHaveTextContent("7");
    expect(getRepoMetricsAction).toHaveBeenCalledWith({
      ...SCOPE,
      repoId: "con_1",
    });
  });

  it("retry failure updates the ErrorState description with the new error", async () => {
    getRepoMetricsAction.mockResolvedValue({
      ok: false,
      error: "GitHub API rate limited",
    });
    const user = userEvent.setup();
    render(
      <OverviewTab
        scope={SCOPE}
        connectionId="con_1"
        initialMetrics={null}
        slug={SLUG}
        onNavigateToBranches={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByText("GitHub API rate limited"),
    ).toBeInTheDocument();
  });

  it("no-slug empty: renders the setup-incomplete empty state when metrics loaded but slug is null", () => {
    render(
      <OverviewTab
        scope={SCOPE}
        connectionId="con_1"
        initialMetrics={makeMetrics()}
        slug={null}
        onNavigateToBranches={vi.fn()}
      />,
    );

    expect(screen.getByText("Repo setup incomplete")).toBeInTheDocument();
    expect(
      screen.getByText(/hasn't resolved an owner\/repo yet/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("repo-overview-tab")).not.toBeInTheDocument();
  });

  it("renders the stat group and error banner for normal, non-zero metrics", () => {
    render(
      <OverviewTab
        scope={SCOPE}
        connectionId="con_1"
        initialMetrics={makeMetrics({
          entityCount: 1234,
          errorMessage: "Last sync partially failed",
        })}
        slug={SLUG}
        onNavigateToBranches={vi.fn()}
      />,
    );

    const tab = screen.getByTestId("repo-overview-tab");
    expect(tab).toHaveTextContent("1,234");
    expect(screen.getByTestId("repo-overview-error")).toHaveTextContent(
      "Last sync partially failed",
    );
    expect(
      screen.queryByTestId("overview-create-branch-cta"),
    ).not.toBeInTheDocument();
  });

  it("zero-entity CTA: renders when entityCount is 0 and calls onNavigateToBranches on click", async () => {
    const onNavigateToBranches = vi.fn();
    const user = userEvent.setup();
    render(
      <OverviewTab
        scope={SCOPE}
        connectionId="con_1"
        initialMetrics={makeMetrics({ entityCount: 0 })}
        slug={SLUG}
        onNavigateToBranches={onNavigateToBranches}
      />,
    );

    expect(screen.getByText("No activity here yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Create your first branch on acme\/widgets/),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("overview-create-branch-cta"));
    expect(onNavigateToBranches).toHaveBeenCalledTimes(1);
  });
});
