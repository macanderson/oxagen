// @vitest-environment jsdom
/**
 * github-connection-wizard-step2.test.tsx — tests for the org → repo selector.
 *
 * Covers the "manage which orgs/repos the GitHub App is installed into" flow:
 *   - Renders installed orgs + the manage-access link on mount.
 *   - Clicking the manage link opens GitHub's install page in a new tab.
 *   - Returning to the window (focus) re-fetches and surfaces a newly-installed org.
 *   - Focus does NOT re-fetch unless the manage page was opened first.
 *   - The Refresh button re-fetches installations.
 *   - The empty state surfaces an install link.
 *   - Selecting an org lists its repos and exposes a per-org "configure on GitHub" link.
 */

import * as React from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Step2SelectRepos } from "./github-connection-wizard-step2";
import type { InstallationsResponse } from "./github-connection-wizard-types";

// ── primitive mocks ───────────────────────────────────────────────────────────

vi.mock("@oxagen/ui", () => ({
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      {...rest}
      type="checkbox"
      checked={Boolean(checked)}
      onChange={() => onCheckedChange?.(!checked)}
    />
  ),
}));

// ── fixtures ──────────────────────────────────────────────────────────────────

const ORG = "acme";
const WS = "main";
const CONN = "con_ABC";

type ReposResponse = {
  totalCount: number;
  repositories: Array<{
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
    language: string | null;
    description: string | null;
  }>;
};

type FetchJson = { ok: boolean; status: number; json: () => Promise<unknown> };

let installationsBody: InstallationsResponse;
let reposBody: ReposResponse;

function renderStep2(onNext = vi.fn()) {
  return render(
    <Step2SelectRepos
      orgSlug={ORG}
      workspaceSlug={WS}
      connectionId={CONN}
      onNext={onNext}
    />,
  );
}

/** Count the installations fetches issued so far (excluding the repos endpoint). */
function installationsFetchCount(): number {
  const fetchMock = global.fetch as unknown as { mock: { calls: unknown[][] } };
  return fetchMock.mock.calls.filter((c) => {
    const url = String(c[0]);
    return url.includes("/installations") && !url.includes("/repositories");
  }).length;
}

beforeEach(() => {
  installationsBody = {
    manageUrl: "https://github.com/apps/oxagen/installations/new",
    installations: [
      {
        id: 111,
        accountLogin: "acme-org",
        accountType: "Organization",
        repositorySelection: "selected",
        avatarUrl: null,
        htmlUrl:
          "https://github.com/organizations/acme-org/settings/installations/111",
      },
    ],
  };
  reposBody = {
    totalCount: 1,
    repositories: [
      {
        id: 1,
        name: "api",
        fullName: "acme-org/api",
        private: true,
        defaultBranch: "main",
        language: "TypeScript",
        description: null,
      },
    ],
  };

  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<FetchJson> => {
    const url = String(input);
    if (url.includes("/repositories")) {
      return { ok: true, status: 200, json: async () => reposBody };
    }
    if (url.includes("/installations")) {
      return { ok: true, status: 200, json: async () => installationsBody };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  window.open = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Step2SelectRepos — manage installations", () => {
  it("renders installed orgs and the manage-access link on mount", async () => {
    renderStep2();
    await screen.findByTestId("installation-item-111");
    expect(screen.getByText("acme-org")).toBeInTheDocument();

    const link = screen.getByTestId("manage-installations-link");
    expect(link).toHaveTextContent("Manage GitHub App access");
  });

  it("opens GitHub's install page in a new tab when the manage link is clicked", async () => {
    renderStep2();
    const link = await screen.findByTestId("manage-installations-link");
    fireEvent.click(link);
    expect(window.open).toHaveBeenCalledWith(
      "https://github.com/apps/oxagen/installations/new",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("re-fetches installations on window focus after the manage page was opened", async () => {
    renderStep2();
    await screen.findByTestId("installation-item-111");

    // User opens the manage page (arms the on-focus refresh).
    fireEvent.click(screen.getByTestId("manage-installations-link"));

    // Simulate them installing the App on a second org while away.
    installationsBody = {
      manageUrl: installationsBody.manageUrl,
      installations: [
        ...installationsBody.installations,
        {
          id: 222,
          accountLogin: "beta-org",
          accountType: "Organization",
          repositorySelection: "all",
          avatarUrl: null,
          htmlUrl: null,
        },
      ],
    };

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await screen.findByTestId("installation-item-222");
    expect(screen.getByText("beta-org")).toBeInTheDocument();
  });

  it("does not re-fetch on focus when the manage page was never opened", async () => {
    renderStep2();
    await screen.findByTestId("installation-item-111");
    const before = installationsFetchCount();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(installationsFetchCount()).toBe(before);
  });

  it("re-fetches installations when the Refresh button is clicked", async () => {
    renderStep2();
    await screen.findByTestId("installation-item-111");
    const before = installationsFetchCount();

    fireEvent.click(screen.getByTestId("refresh-installations-btn"));

    await waitFor(() => expect(installationsFetchCount()).toBe(before + 1));
  });

  it("surfaces an install link in the empty state", async () => {
    installationsBody = {
      manageUrl: "https://github.com/apps/oxagen/installations/new",
      installations: [],
    };
    renderStep2();

    const link = await screen.findByTestId("manage-installations-link");
    expect(link).toHaveTextContent("Install the GitHub App on an organization");
  });

  it("selects an org, lists its repos, and exposes the configure-on-github link", async () => {
    renderStep2();
    fireEvent.click(await screen.findByTestId("installation-item-111"));

    await screen.findByTestId("repository-list");
    expect(screen.getByText("api")).toBeInTheDocument();

    const configure = screen.getByTestId("configure-repos-link");
    fireEvent.click(configure);
    expect(window.open).toHaveBeenCalledWith(
      "https://github.com/organizations/acme-org/settings/installations/111",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("calls onNext with SelectedRepoMeta[] including defaultBranch", async () => {
    // Step2 must forward defaultBranch to Step3 so the PUT body can carry it
    // to the handler — the handler needs it to populate deliveryConfig before
    // firing the ingestion event.
    const onNext = vi.fn();
    renderStep2(onNext);

    // Select the org
    fireEvent.click(await screen.findByTestId("installation-item-111"));

    // Wait for repos to load and select the first one
    const repoCheckbox = await screen.findByTestId("repo-checkbox-api");
    fireEvent.click(repoCheckbox);

    // Click Continue
    fireEvent.click(screen.getByTestId("select-repos-next-btn"));

    expect(onNext).toHaveBeenCalledOnce();
    const [installationId, repos] = onNext.mock.calls[0] as [
      string,
      Array<{ fullName: string; defaultBranch: string }>,
    ];
    expect(installationId).toBe("111");
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      fullName: "acme-org/api",
      defaultBranch: "main",
    });
  });
});
