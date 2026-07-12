// @vitest-environment jsdom
/**
 * repo-drawers.test.tsx — unit tests for the four Repos-list drawer forms:
 * CreateRepoDrawer, ForkRepoDrawer, ConfigureRepoDrawer, EditFileLauncherDrawer.
 *
 * Mocks ./actions (mirrors actions.test.ts's ActionResult shape) and
 * @/components/ui/toast; renders the real Drawer/Sheet + form primitives.
 * Base UI's Select popup cannot be opened in jsdom (no floating-ui layout —
 * see packages/ui/src/components/select.test.tsx's documented constraint), so
 * the EditFileLauncher "Select vs manual entry" fallback is exercised through
 * its real, non-popup-dependent branch: the `resolvable` repos list (parsed
 * via parseRepoSlug) drives the *initial* `choice`, which in turn drives
 * whether the manual owner/repo inputs render — no popup interaction needed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CreateRepoDrawer,
  ForkRepoDrawer,
  ConfigureRepoDrawer,
  EditFileLauncherDrawer,
} from "./repo-drawers";
import type { RepoRow } from "@/lib/workbench/repos";

const {
  createRepoAction,
  forkRepoAction,
  configureRepoAction,
  editRepoFileAction,
} = vi.hoisted(() => ({
  createRepoAction: vi.fn(),
  forkRepoAction: vi.fn(),
  configureRepoAction: vi.fn(),
  editRepoFileAction: vi.fn(),
}));

vi.mock("./actions", () => ({
  createRepoAction,
  forkRepoAction,
  configureRepoAction,
  editRepoFileAction,
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
    lastSyncAt: null,
    healthStatus: "healthy",
    lastPollAt: null,
    nextPollAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    metrics: null,
    metricsError: null,
    ...overrides,
  } as RepoRow;
}

// ---------------------------------------------------------------------------
// CreateRepoDrawer
// ---------------------------------------------------------------------------

describe("CreateRepoDrawer", () => {
  it("submit success shows the result and 'Create another' resets the form", async () => {
    createRepoAction.mockResolvedValue({
      ok: true,
      result: {
        fullName: "acme/new-repo",
        htmlUrl: "https://github.com/acme/new-repo",
        defaultBranch: "main",
      },
    });
    const user = userEvent.setup();
    render(<CreateRepoDrawer open={true} onOpenChange={vi.fn()} {...SCOPE} />);

    await user.type(screen.getByTestId("create-repo-name-input"), "new-repo");
    await user.click(screen.getByTestId("create-repo-submit"));

    const success = await screen.findByTestId("create-repo-success");
    expect(within(success).getByText("acme/new-repo")).toBeInTheDocument();
    expect(createRepoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "eng",
        name: "new-repo",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Create another" }));
    expect(screen.queryByTestId("create-repo-success")).not.toBeInTheDocument();
    expect(screen.getByTestId("create-repo-name-input")).toHaveValue("");
  });

  it("submit error displays the error and keeps the form visible", async () => {
    createRepoAction.mockResolvedValue({
      ok: false,
      error: "Name already taken",
    });
    const user = userEvent.setup();
    render(<CreateRepoDrawer open={true} onOpenChange={vi.fn()} {...SCOPE} />);

    await user.type(screen.getByTestId("create-repo-name-input"), "taken-name");
    await user.click(screen.getByTestId("create-repo-submit"));

    expect(await screen.findByText("Name already taken")).toBeInTheDocument();
    expect(screen.queryByTestId("create-repo-success")).not.toBeInTheDocument();
    expect(screen.getByTestId("create-repo-name-input")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ForkRepoDrawer
// ---------------------------------------------------------------------------

describe("ForkRepoDrawer", () => {
  it("submit success shows the result and 'Fork another' resets the form", async () => {
    forkRepoAction.mockResolvedValue({
      ok: true,
      result: {
        fullName: "acme/hello-world",
        htmlUrl: "https://github.com/acme/hello-world",
        defaultBranch: "main",
      },
    });
    const user = userEvent.setup();
    render(<ForkRepoDrawer open={true} onOpenChange={vi.fn()} {...SCOPE} />);

    await user.type(screen.getByTestId("fork-repo-owner-input"), "octocat");
    await user.type(screen.getByTestId("fork-repo-name-input"), "hello-world");
    await user.click(screen.getByTestId("fork-repo-submit"));

    const success = await screen.findByTestId("fork-repo-success");
    expect(within(success).getByText("acme/hello-world")).toBeInTheDocument();
    expect(forkRepoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "eng",
        owner: "octocat",
        repo: "hello-world",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Fork another" }));
    expect(screen.queryByTestId("fork-repo-success")).not.toBeInTheDocument();
    expect(screen.getByTestId("fork-repo-owner-input")).toHaveValue("");
  });

  it("submit error displays the error and keeps the form visible", async () => {
    forkRepoAction.mockResolvedValue({
      ok: false,
      error: "Repository not found",
    });
    const user = userEvent.setup();
    render(<ForkRepoDrawer open={true} onOpenChange={vi.fn()} {...SCOPE} />);

    await user.type(screen.getByTestId("fork-repo-owner-input"), "ghost");
    await user.type(screen.getByTestId("fork-repo-name-input"), "nope");
    await user.click(screen.getByTestId("fork-repo-submit"));

    expect(await screen.findByText("Repository not found")).toBeInTheDocument();
    expect(screen.queryByTestId("fork-repo-success")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ConfigureRepoDrawer
// ---------------------------------------------------------------------------

describe("ConfigureRepoDrawer", () => {
  it("submit success calls onSaved and closes the drawer", async () => {
    configureRepoAction.mockResolvedValue({ ok: true, result: {} });
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfigureRepoDrawer
        target={makeRow()}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
        {...SCOPE}
      />,
    );

    await user.click(screen.getByTestId("configure-repo-submit"));

    expect(configureRepoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "eng",
        repoId: "con_1",
      }),
    );
    await vi.waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("submit error displays the error and does not call onSaved", async () => {
    configureRepoAction.mockResolvedValue({
      ok: false,
      error: "Invalid polling interval",
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfigureRepoDrawer
        target={makeRow()}
        onOpenChange={vi.fn()}
        onSaved={onSaved}
        {...SCOPE}
      />,
    );

    await user.click(screen.getByTestId("configure-repo-submit"));

    expect(
      await screen.findByText("Invalid polling interval"),
    ).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EditFileLauncherDrawer
// ---------------------------------------------------------------------------

describe("EditFileLauncherDrawer", () => {
  it("shows the manual owner/repo inputs by default when no repo resolves a slug", () => {
    // displayName "GitHub" is the pending_setup literal parseRepoSlug can't parse.
    render(
      <EditFileLauncherDrawer
        open={true}
        onOpenChange={vi.fn()}
        repos={[makeRow({ displayName: "GitHub" })]}
        {...SCOPE}
      />,
    );

    expect(screen.getByLabelText("Owner")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository")).toBeInTheDocument();
  });

  it("defaults to the first resolvable repo and hides manual inputs", () => {
    render(
      <EditFileLauncherDrawer
        open={true}
        onOpenChange={vi.fn()}
        repos={[makeRow({ displayName: "acme/widgets" })]}
        {...SCOPE}
      />,
    );

    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Repository")).not.toBeInTheDocument();
  });

  it("submitting via the manual fallback calls editRepoFileAction with the typed owner/repo", async () => {
    editRepoFileAction.mockResolvedValue({
      ok: true,
      result: {
        prNumber: 42,
        prUrl: "https://github.com/acme/widgets/pull/42",
        branch: "agent/fix-bug",
        changedFiles: ["src/index.ts"],
        summary: "Fixed the bug.",
      },
    });
    const user = userEvent.setup();
    render(
      <EditFileLauncherDrawer
        open={true}
        onOpenChange={vi.fn()}
        repos={[makeRow({ displayName: "GitHub" })]}
        {...SCOPE}
      />,
    );

    await user.type(screen.getByLabelText("Owner"), "octocat");
    await user.type(screen.getByLabelText("Repository"), "hello-world");
    await user.type(
      screen.getByTestId("edit-file-instruction-input"),
      "Update src/index.ts to add error handling",
    );
    await user.click(screen.getByTestId("edit-file-launcher-submit"));

    const success = await screen.findByTestId("edit-file-launcher-success");
    expect(within(success).getByText("#42")).toBeInTheDocument();
    expect(editRepoFileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "eng",
        owner: "octocat",
        repo: "hello-world",
        instruction: "Update src/index.ts to add error handling",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Start another" }));
    expect(
      screen.queryByTestId("edit-file-launcher-success"),
    ).not.toBeInTheDocument();
  });

  it("submit error displays the error and keeps the form visible", async () => {
    editRepoFileAction.mockResolvedValue({
      ok: false,
      error: "The coding agent failed to complete this edit.",
    });
    const user = userEvent.setup();
    render(
      <EditFileLauncherDrawer
        open={true}
        onOpenChange={vi.fn()}
        repos={[makeRow({ displayName: "GitHub" })]}
        {...SCOPE}
      />,
    );

    await user.type(screen.getByLabelText("Owner"), "octocat");
    await user.type(screen.getByLabelText("Repository"), "hello-world");
    await user.type(
      screen.getByTestId("edit-file-instruction-input"),
      "Update src/index.ts to add error handling",
    );
    await user.click(screen.getByTestId("edit-file-launcher-submit"));

    expect(
      await screen.findByText("The coding agent failed to complete this edit."),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("edit-file-launcher-success"),
    ).not.toBeInTheDocument();
  });

  it("disables submit until owner, repo, and a >=10 char instruction are present", async () => {
    const user = userEvent.setup();
    render(
      <EditFileLauncherDrawer
        open={true}
        onOpenChange={vi.fn()}
        repos={[makeRow({ displayName: "GitHub" })]}
        {...SCOPE}
      />,
    );

    expect(screen.getByTestId("edit-file-launcher-submit")).toBeDisabled();

    await user.type(screen.getByLabelText("Owner"), "octocat");
    await user.type(screen.getByLabelText("Repository"), "hello-world");
    expect(screen.getByTestId("edit-file-launcher-submit")).toBeDisabled();

    await user.type(
      screen.getByTestId("edit-file-instruction-input"),
      "too short",
    );
    expect(screen.getByTestId("edit-file-launcher-submit")).toBeDisabled();

    await user.type(
      screen.getByTestId("edit-file-instruction-input"),
      " now long enough",
    );
    expect(screen.getByTestId("edit-file-launcher-submit")).toBeEnabled();
  });
});
