// @vitest-environment jsdom
/**
 * review-row-actions.test.tsx — unit tests for ReviewRowActions client component.
 *
 * Covers:
 *   - renders Confirm button in idle state
 *   - Revoke button hidden when canRevoke=false
 *   - Confirm: single click → calls confirmMemberAccessAction → shows Confirmed badge
 *   - Confirm: action returns error → shows error message
 *   - Revoke: two clicks (confirm flow) → calls revokeMemberAccessAction
 *   - Revoke: denied → shows error badge
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
import { ReviewRowActions } from "./review-row-actions";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockConfirmAction = vi.fn();
const mockRevokeAction = vi.fn();

vi.mock("../actions", () => ({
  confirmMemberAccessAction: (...args: unknown[]) => mockConfirmAction(...args),
  revokeMemberAccessAction: (...args: unknown[]) => mockRevokeAction(...args),
}));

const DEFAULT_PROPS = {
  orgSlug: "acme",
  targetUserId: "user-target",
  targetUserName: "Alice",
  canRevoke: true,
  isSelf: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReviewRowActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirmAction.mockResolvedValue({ ok: true });
    mockRevokeAction.mockResolvedValue({ ok: true });
  });

  it("renders Confirm button in idle state (title attribute present)", () => {
    const { container } = render(<ReviewRowActions {...DEFAULT_PROPS} />);
    const confirmBtn = container.querySelector(
      '[title="Confirm access is appropriate"]',
    );
    expect(confirmBtn).not.toBeNull();
  });

  it("renders Revoke button in idle state when canRevoke=true", () => {
    const { container } = render(<ReviewRowActions {...DEFAULT_PROPS} />);
    const revokeBtn = container.querySelector(
      '[title="Remove member\'s access"]',
    );
    expect(revokeBtn).not.toBeNull();
  });

  it("does not render Revoke button when canRevoke=false", () => {
    const { container } = render(
      <ReviewRowActions {...DEFAULT_PROPS} canRevoke={false} />,
    );
    const revokeBtn = container.querySelector(
      '[title="Remove member\'s access"]',
    );
    expect(revokeBtn).toBeNull();
  });

  it("shows 'You' badge and no Revoke button when isSelf=true", () => {
    const { container, getByText } = render(
      <ReviewRowActions {...DEFAULT_PROPS} isSelf={true} />,
    );
    expect(getByText("You")).toBeDefined();
    expect(
      container.querySelector('[title="Remove member\'s access"]'),
    ).toBeNull();
  });

  it("calls confirmMemberAccessAction with correct args on Confirm click", async () => {
    const { container } = render(<ReviewRowActions {...DEFAULT_PROPS} />);
    const confirmBtn = container.querySelector(
      '[title="Confirm access is appropriate"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => {
      expect(mockConfirmAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        targetUserId: "user-target",
      });
    });
  });

  it("shows Confirmed badge after successful confirmMemberAccessAction", async () => {
    const { container, getByText } = render(
      <ReviewRowActions {...DEFAULT_PROPS} />,
    );
    const confirmBtn = container.querySelector(
      '[title="Confirm access is appropriate"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => {
      expect(getByText("Confirmed")).toBeDefined();
    });
  });

  it("shows 'Permission denied' error when confirmMemberAccessAction returns ok:false", async () => {
    mockConfirmAction.mockResolvedValue({ ok: false, code: "forbidden" });
    const { container, getByText } = render(
      <ReviewRowActions {...DEFAULT_PROPS} />,
    );
    const confirmBtn = container.querySelector(
      '[title="Confirm access is appropriate"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => {
      expect(getByText("Permission denied")).toBeDefined();
    });
    expect(getByText("Dismiss")).toBeDefined();
  });

  it("first click on Revoke shows confirmation prompt with Cancel", async () => {
    const { container, getByText } = render(
      <ReviewRowActions {...DEFAULT_PROPS} />,
    );
    const revokeBtn = container.querySelector(
      '[title="Remove member\'s access"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(revokeBtn);
    });
    await waitFor(() => {
      expect(getByText(/Remove Alice/)).toBeDefined();
    });
    expect(getByText("Cancel")).toBeDefined();
  });

  it("Cancel in confirm state returns to idle", async () => {
    const { container, getByText } = render(
      <ReviewRowActions {...DEFAULT_PROPS} />,
    );
    const revokeBtn = container.querySelector(
      '[title="Remove member\'s access"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(revokeBtn);
    });
    await waitFor(() => getByText("Cancel"));
    await act(async () => {
      fireEvent.click(getByText("Cancel"));
    });
    // Should be back to idle - confirm button should be present again
    await waitFor(() => {
      expect(
        container.querySelector('[title="Confirm access is appropriate"]'),
      ).not.toBeNull();
    });
  });

  it("second Confirm click calls revokeMemberAccessAction and shows Revoked badge", async () => {
    const { container, getByText } = render(
      <ReviewRowActions {...DEFAULT_PROPS} />,
    );
    const revokeBtn = container.querySelector(
      '[title="Remove member\'s access"]',
    ) as HTMLElement;
    // First click → confirming_revoke
    await act(async () => {
      fireEvent.click(revokeBtn);
    });
    await waitFor(() => getByText("Confirm"));
    // Second click → calls action
    await act(async () => {
      fireEvent.click(getByText("Confirm"));
    });
    await waitFor(() => {
      expect(mockRevokeAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        targetUserId: "user-target",
      });
    });
    expect(getByText("Revoked")).toBeDefined();
  });

  it("shows self_action error message when revoking returns self_action", async () => {
    mockRevokeAction.mockResolvedValue({ ok: false, code: "self_action" });
    const { container, getByText } = render(
      <ReviewRowActions {...DEFAULT_PROPS} />,
    );
    const revokeBtn = container.querySelector(
      '[title="Remove member\'s access"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(revokeBtn);
    });
    await waitFor(() => getByText("Confirm"));
    await act(async () => {
      fireEvent.click(getByText("Confirm"));
    });
    await waitFor(() => {
      expect(getByText("Cannot revoke your own access.")).toBeDefined();
    });
  });
});
