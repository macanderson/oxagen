// @vitest-environment jsdom
/**
 * notifications-bell.test.tsx — render + interaction tests for NotificationsBell.
 *
 * Covers:
 *   - Bell button renders with "Open notifications" aria-label
 *   - No unread badge when unreadCount = 0
 *   - Badge shows unread count after load
 *   - Renders "No notifications yet" empty state when list is empty
 *   - 99+ cap on badge
 *
 * Uses real timers (not fake timers) to avoid waitFor/fake-timer deadlocks.
 * The component defers load via setTimeout(0); with real timers these flush
 * before waitFor resolves.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationsBell } from "./notifications-bell";

afterEach(() => {
  cleanup();
});

// Mock next/navigation useParams
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme", workspaceSlug: "prod" }),
}));

const { listNotificationsActionMock, markNotificationActionMock } = vi.hoisted(() => ({
  listNotificationsActionMock: vi.fn(),
  markNotificationActionMock: vi.fn(),
}));

vi.mock("./notifications", () => ({
  listNotificationsAction: listNotificationsActionMock,
  markNotificationAction: markNotificationActionMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  listNotificationsActionMock.mockResolvedValue({ notifications: [], unreadCount: 0 });
  markNotificationActionMock.mockResolvedValue({ ok: true });
});

describe("NotificationsBell — initial render", () => {
  it("renders the bell button without waiting for load", () => {
    render(<NotificationsBell />);
    expect(screen.getByRole("button", { name: /open notifications/i })).toBeInTheDocument();
  });

  it("calls listNotificationsAction on mount", async () => {
    render(<NotificationsBell />);
    await waitFor(() => expect(listNotificationsActionMock).toHaveBeenCalled(), { timeout: 2000 });
  });

  it("shows an unread badge when unreadCount > 0", async () => {
    listNotificationsActionMock.mockResolvedValue({ notifications: [], unreadCount: 5 });
    render(<NotificationsBell />);
    await waitFor(() => expect(screen.getByText("5")).toBeInTheDocument(), { timeout: 2000 });
  });

  it("aria-label includes unread count when positive", async () => {
    listNotificationsActionMock.mockResolvedValue({ notifications: [], unreadCount: 3 });
    render(<NotificationsBell />);
    await waitFor(
      () => expect(screen.getByRole("button", { name: /3 unread/i })).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });
});

describe("NotificationsBell — empty state", () => {
  it("shows 'No notifications yet' in the sheet after opening", async () => {
    render(<NotificationsBell />);
    await userEvent.click(screen.getByRole("button", { name: /open notifications/i }));
    await waitFor(
      () => expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });
});

describe("NotificationsBell — 99+ cap", () => {
  it("caps badge at '99+' when unreadCount > 99", async () => {
    listNotificationsActionMock.mockResolvedValue({ notifications: [], unreadCount: 150 });
    render(<NotificationsBell />);
    await waitFor(() => expect(screen.getByText("99+")).toBeInTheDocument(), { timeout: 2000 });
  });
});
