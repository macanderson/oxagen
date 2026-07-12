// @vitest-environment jsdom
/**
 * locks-tab.test.tsx — unit tests for the Locks tab.
 *
 * Covers: loads locks on mount via listFileLocksAction, renders each lock's
 * naturalKey/agentId (never a bare lockId as the primary label — the lockId
 * only appears in the small CopyableId chip), the empty state when there are
 * no locks, and that Release calls releaseFileLockAction and is hidden for a
 * non-manager.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocksTab } from "./locks-tab";

const { listFileLocksAction, releaseFileLockAction } = vi.hoisted(() => ({
  listFileLocksAction: vi.fn(),
  releaseFileLockAction: vi.fn(),
}));

vi.mock("../actions", () => ({ listFileLocksAction, releaseFileLockAction }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

const LOCK = {
  lockId: "lock_abc123",
  naturalKey: "github:acme/widgets:src/index.ts",
  agentId: "coding-agent",
  acquiredAt: Date.now(),
  expiresAt: Date.now() + 300_000,
  workspaceId: "w1",
  action: "write",
  executionId: "exec_1",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocksTab", () => {
  it("loads and renders locks by naturalKey + agentId (not a raw lockId as the primary label)", async () => {
    listFileLocksAction.mockResolvedValue({ ok: true, locks: [LOCK] });
    render(
      <LocksTab
        scope={{ orgSlug: "acme", workspaceSlug: "eng" }}
        slug={{ owner: "acme", repo: "widgets" }}
        canManage={true}
      />,
    );
    const row = await screen.findByTestId("lock-row-lock_abc123");
    expect(within(row).getByText(LOCK.naturalKey)).toBeInTheDocument();
    expect(within(row).getByText("coding-agent")).toBeInTheDocument();
    expect(listFileLocksAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "eng",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("renders the empty state when there are no locks", async () => {
    listFileLocksAction.mockResolvedValue({ ok: true, locks: [] });
    render(
      <LocksTab
        scope={{ orgSlug: "acme", workspaceSlug: "eng" }}
        slug={{ owner: "acme", repo: "widgets" }}
        canManage={true}
      />,
    );
    await waitFor(() => expect(listFileLocksAction).toHaveBeenCalled());
    expect(await screen.findByText("No active locks")).toBeInTheDocument();
  });

  it("hides the Release action for a non-manager", async () => {
    listFileLocksAction.mockResolvedValue({ ok: true, locks: [LOCK] });
    render(
      <LocksTab
        scope={{ orgSlug: "acme", workspaceSlug: "eng" }}
        slug={{ owner: "acme", repo: "widgets" }}
        canManage={false}
      />,
    );
    await screen.findByTestId("lock-row-lock_abc123");
    expect(
      screen.queryByTestId("lock-release-lock_abc123"),
    ).not.toBeInTheDocument();
  });

  it("Release calls releaseFileLockAction and refreshes the list", async () => {
    listFileLocksAction
      .mockResolvedValueOnce({ ok: true, locks: [LOCK] })
      .mockResolvedValueOnce({ ok: true, locks: [] });
    releaseFileLockAction.mockResolvedValue({ ok: true, released: true });
    const user = userEvent.setup();
    render(
      <LocksTab
        scope={{ orgSlug: "acme", workspaceSlug: "eng" }}
        slug={{ owner: "acme", repo: "widgets" }}
        canManage={true}
      />,
    );
    await user.click(await screen.findByTestId("lock-release-lock_abc123"));
    expect(releaseFileLockAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "eng",
      lockId: "lock_abc123",
    });
    await waitFor(() => expect(listFileLocksAction).toHaveBeenCalledTimes(2));
  });
});
