// @vitest-environment jsdom
/**
 * github-app-status-action.test.tsx — unit tests for GithubAppStatusAction.
 *
 * Covers all four render branches: loading (pulse skeleton before
 * fetchGithubStatus resolves), error (fetch rejects), disconnected (renders
 * "Connect GitHub App" linking to the identity URL), and connected (renders
 * "Manage / disconnect GitHub App" linking externally to the manage URL).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { GithubAppStatusAction } from "./github-app-status-action";
import type { GithubStatusResponse } from "@/lib/github";

const { fetchGithubStatus } = vi.hoisted(() => ({
  fetchGithubStatus: vi.fn(),
}));

vi.mock("@/lib/github", () => ({ fetchGithubStatus }));
vi.mock("@/lib/routes", () => ({
  workspace: {
    settings: {
      github: ({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) =>
        `/${orgSlug}/${workspaceSlug}/settings/github`,
    },
  },
}));

const PROPS = { orgSlug: "acme", workspaceSlug: "eng" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GithubAppStatusAction", () => {
  it("loading: shows the pulse skeleton before the status resolves", () => {
    let resolveStatus!: (value: GithubStatusResponse) => void;
    fetchGithubStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const { container } = render(<GithubAppStatusAction {...PROPS} />);

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByTestId("repos-connect-github-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repos-manage-github-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repos-github-status-error")).not.toBeInTheDocument();

    // Resolve so the pending act() doesn't leak into the next test.
    resolveStatus({
      connected: false,
      installations: [],
      manageUrl: "https://github.com/settings/installations",
      identityUrl: "https://github.com/login/oauth/authorize?state=abc",
      installUrl: "https://github.com/apps/oxagen/installations/new",
    } as GithubStatusResponse);
  });

  it("error: shows the fallback link to Settings -> GitHub when the fetch rejects", async () => {
    fetchGithubStatus.mockRejectedValue(new Error("GitHub API unreachable"));

    render(<GithubAppStatusAction {...PROPS} />);

    const error = await screen.findByTestId("repos-github-status-error");
    expect(error).toHaveTextContent("GitHub App status unavailable");
    const link = screen.getByRole("link", { name: "check Settings → GitHub" });
    expect(link).toHaveAttribute("href", "/acme/eng/settings/github");
  });

  it("disconnected: renders a Connect GitHub App button linking to the identity URL", async () => {
    fetchGithubStatus.mockResolvedValue({
      connected: false,
      installations: [],
      manageUrl: "https://github.com/settings/installations",
      identityUrl: "https://github.com/login/oauth/authorize?state=abc",
      installUrl: "https://github.com/apps/oxagen/installations/new",
    } as GithubStatusResponse);

    render(<GithubAppStatusAction {...PROPS} />);

    const btn = await screen.findByTestId("repos-connect-github-btn");
    expect(btn).toHaveTextContent("Connect GitHub App");
    expect(btn).toHaveAttribute("href", "https://github.com/login/oauth/authorize?state=abc");
  });

  it("connected: renders a Manage/disconnect button linking externally to the manage URL", async () => {
    fetchGithubStatus.mockResolvedValue({
      connected: true,
      installations: [{ id: 1 }],
      manageUrl: "https://github.com/settings/installations/1",
      identityUrl: "",
    } as unknown as GithubStatusResponse);

    render(<GithubAppStatusAction {...PROPS} />);

    const btn = await screen.findByTestId("repos-manage-github-btn");
    expect(btn).toHaveTextContent("Manage / disconnect GitHub App");
    expect(btn).toHaveAttribute("href", "https://github.com/settings/installations/1");
    expect(btn).toHaveAttribute("target", "_blank");
    expect(btn).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("re-fetches when orgSlug/workspaceSlug change", async () => {
    fetchGithubStatus.mockResolvedValue({
      connected: false,
      installations: [],
      manageUrl: "https://github.com/settings/installations",
      identityUrl: "https://github.com/login/oauth/authorize?state=abc",
      installUrl: "https://github.com/apps/oxagen/installations/new",
    } as GithubStatusResponse);

    const { rerender } = render(<GithubAppStatusAction {...PROPS} />);
    await screen.findByTestId("repos-connect-github-btn");
    expect(fetchGithubStatus).toHaveBeenCalledWith("acme", "eng", expect.anything());

    rerender(<GithubAppStatusAction orgSlug="acme" workspaceSlug="other-ws" />);
    await waitFor(() =>
      expect(fetchGithubStatus).toHaveBeenCalledWith("acme", "other-ws", expect.anything()),
    );
  });
});
