// @vitest-environment jsdom
/**
 * revoke-session-button.test.tsx — unit tests for RevokeSessionButton.
 *
 * Covers:
 *   - renders a Revoke button in idle state
 *   - first click → shows confirmation state (userName + Confirm + Cancel)
 *   - Cancel returns to idle
 *   - second click Confirm → calls revokeSessionAction with correct input
 *   - revokeSessionAction error → shows error + Dismiss
 *   - forbidden error → shows role-required message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { RevokeSessionButton } from "./revoke-session-button";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRevokeAction = vi.fn();

vi.mock("../actions", () => ({
  revokeSessionAction: (...args: unknown[]) => mockRevokeAction(...args),
}));

const DEFAULT_PROPS = {
  orgSlug: "acme",
  sessionId: "sess-abc",
  targetUserId: "user-target",
  userName: "Bob",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RevokeSessionButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevokeAction.mockResolvedValue({ ok: true });
  });

  it("renders Revoke button in idle state", () => {
    const { container } = render(<RevokeSessionButton {...DEFAULT_PROPS} />);
    // Button has title="Revoke session"
    const btn = container.querySelector('[title="Revoke session"]');
    expect(btn).not.toBeNull();
  });

  it("first click shows confirmation prompt with userName", async () => {
    const { container, getByText } = render(
      <RevokeSessionButton {...DEFAULT_PROPS} />,
    );
    const btn = container.querySelector(
      '[title="Revoke session"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(getByText(/Revoke Bob/)).toBeDefined();
    });
    expect(getByText("Confirm")).toBeDefined();
    expect(getByText("Cancel")).toBeDefined();
  });

  it("Cancel returns to idle (shows Revoke session button)", async () => {
    const { container, getByText } = render(
      <RevokeSessionButton {...DEFAULT_PROPS} />,
    );
    const btn = container.querySelector(
      '[title="Revoke session"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => getByText("Cancel"));
    await act(async () => {
      fireEvent.click(getByText("Cancel"));
    });
    await waitFor(() => {
      expect(
        container.querySelector('[title="Revoke session"]'),
      ).not.toBeNull();
    });
  });

  it("second click Confirm calls revokeSessionAction with correct input", async () => {
    const { container, getByText } = render(
      <RevokeSessionButton {...DEFAULT_PROPS} />,
    );
    // First click → confirming state
    const btn = container.querySelector(
      '[title="Revoke session"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => getByText("Confirm"));
    // Second click → triggers action
    await act(async () => {
      fireEvent.click(getByText("Confirm"));
    });
    await waitFor(() => {
      expect(mockRevokeAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        sessionId: "sess-abc",
        targetUserId: "user-target",
      });
    });
  });

  it("shows error and Dismiss when revokeSessionAction returns internal error", async () => {
    mockRevokeAction.mockResolvedValue({
      ok: false,
      code: "internal",
      error: "DB timeout",
    });
    const { container, getByText } = render(
      <RevokeSessionButton {...DEFAULT_PROPS} />,
    );
    const btn = container.querySelector(
      '[title="Revoke session"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => getByText("Confirm"));
    await act(async () => {
      fireEvent.click(getByText("Confirm"));
    });
    await waitFor(() => {
      expect(getByText("DB timeout")).toBeDefined();
    });
    expect(getByText("Dismiss")).toBeDefined();
  });

  it("shows forbidden message when revokeSessionAction returns forbidden", async () => {
    mockRevokeAction.mockResolvedValue({ ok: false, code: "forbidden" });
    const { container, getByText } = render(
      <RevokeSessionButton {...DEFAULT_PROPS} />,
    );
    const btn = container.querySelector(
      '[title="Revoke session"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => getByText("Confirm"));
    await act(async () => {
      fireEvent.click(getByText("Confirm"));
    });
    await waitFor(() => {
      expect(getByText("Owner or admin role required.")).toBeDefined();
    });
  });

  it("Dismiss resets error state back to idle", async () => {
    mockRevokeAction.mockResolvedValue({ ok: false, code: "not_found" });
    const { container, getByText } = render(
      <RevokeSessionButton {...DEFAULT_PROPS} />,
    );
    const btn = container.querySelector(
      '[title="Revoke session"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => getByText("Confirm"));
    await act(async () => {
      fireEvent.click(getByText("Confirm"));
    });
    await waitFor(() => getByText("Dismiss"));
    await act(async () => {
      fireEvent.click(getByText("Dismiss"));
    });
    await waitFor(() => {
      expect(
        container.querySelector('[title="Revoke session"]'),
      ).not.toBeNull();
    });
  });
});
