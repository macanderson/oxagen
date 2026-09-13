// @vitest-environment jsdom
/**
 * org-privacy-panel.test.tsx — unit tests for OrgPrivacyPanel.
 *
 * Covers:
 *   (1) Initial render: export + delete buttons visible
 *   (2) Export click: shows "Submitting request…" while pending, then queued text
 *   (3) Export polling ready: poll resolves with status=ready+URL → download link
 *   (4) Export polling failed: poll resolves with status=failed → error message
 *   (5) Export error: action rejects → error message
 *   (6) Delete click: shows confirming state with confirm + cancel buttons
 *   (7) Cancel: returns to idle (Delete organization button re-appears)
 *   (8) Confirm erase: calls requestOrgDataEraseAction, shows queued state w/ date
 *   (9) Erase error: action rejects → error message
 */

import * as React from "react";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./org-privacy-actions", () => ({
  requestOrgDataExportAction: vi.fn(),
  requestOrgDataEraseAction: vi.fn(),
  getOrgExportStatusAction: vi.fn(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant: _v,
    size: _s,
    className: _c,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    variant?: string;
    size?: string;
    className?: string;
  }) => <button onClick={onClick}>{children}</button>,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { OrgPrivacyPanel } from "./org-privacy-panel";
import {
  requestOrgDataExportAction,
  requestOrgDataEraseAction,
  getOrgExportStatusAction,
} from "./org-privacy-actions";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockExport = vi.mocked(requestOrgDataExportAction);
const mockErase = vi.mocked(requestOrgDataEraseAction);
const mockPoll = vi.mocked(getOrgExportStatusAction);

const ORG_SLUG = "acme";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrgPrivacyPanel", () => {
  // (1) Initial render
  it("renders the export and delete buttons in idle state", () => {
    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    expect(
      screen.getByRole("button", { name: /request organization export/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete organization/i }),
    ).toBeInTheDocument();
  });

  // (2) Export click: shows "Submitting request…" then queued state
  it("shows pending text immediately on export click, then queued text after resolve", async () => {
    let resolveExport!: (v: { exportId: string; status: string }) => void;
    mockExport.mockReturnValue(
      new Promise<{ exportId: string; status: string }>((res) => {
        resolveExport = res;
      }),
    );

    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    fireEvent.click(
      screen.getByRole("button", { name: /request organization export/i }),
    );

    // While the action is in-flight, show "Submitting request…"
    expect(await screen.findByText(/submitting request/i)).toBeInTheDocument();

    // Resolve the action
    await act(async () => {
      resolveExport({ exportId: "export-abc", status: "queued" });
    });

    expect(await screen.findByText(/being prepared/i)).toBeInTheDocument();
    expect(mockExport).toHaveBeenCalledWith(ORG_SLUG);
  });

  // (3) Export polling ready: download link appears after poll returns ready+URL
  it("shows a download link after the poll resolves with status=ready", async () => {
    // Use real timers + a mock that resolves immediately via the poll mock.
    // We trigger the component's poll cycle by making the action resolve first,
    // then manually advance through the setInterval with fake timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockExport.mockResolvedValue({
      exportId: "export-ready",
      status: "queued",
    });
    mockPoll.mockResolvedValue({
      status: "ready",
      exportUrl: "https://cdn.example.com/export.zip",
    });

    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    // Click export button
    fireEvent.click(
      screen.getByRole("button", { name: /request organization export/i }),
    );

    // Flush the requestOrgDataExportAction promise
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(
      screen.getByRole("link", { name: /download zip archive/i }),
    ).toBeInTheDocument();
    expect(mockPoll).toHaveBeenCalledWith(ORG_SLUG, "export-ready");

    vi.useRealTimers();
  });

  // (4) Export polling failed
  it("shows an error message when the poll returns status=failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockExport.mockResolvedValue({ exportId: "export-fail", status: "queued" });
    mockPoll.mockResolvedValue({ status: "failed", exportUrl: null });

    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    fireEvent.click(
      screen.getByRole("button", { name: /request organization export/i }),
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText(/export failed/i)).toBeInTheDocument();

    vi.useRealTimers();
  });

  // (5) Export error: action rejects → error message
  it("shows an error message when requestOrgDataExportAction rejects", async () => {
    mockExport.mockRejectedValue(new Error("Network error"));

    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /request organization export/i }),
      );
    });

    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
  });

  // (6) Delete click: shows confirming state
  it("shows confirming state with confirm and cancel buttons after delete click", () => {
    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    fireEvent.click(
      screen.getByRole("button", { name: /delete organization/i }),
    );

    expect(
      screen.getByRole("button", { name: /yes, delete organization/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  // (7) Cancel: returns to idle
  it("returns to idle when Cancel is clicked in confirming state", () => {
    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    fireEvent.click(
      screen.getByRole("button", { name: /delete organization/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    // The "Delete organization" button must be back
    expect(
      screen.getByRole("button", { name: /delete organization/i }),
    ).toBeInTheDocument();
    // Confirm button must be gone
    expect(
      screen.queryByRole("button", { name: /yes, delete organization/i }),
    ).not.toBeInTheDocument();
  });

  // (8) Confirm erase: calls action, shows queued state with effective date
  it("calls requestOrgDataEraseAction and shows scheduled state with effective date", async () => {
    const effectiveAt = "2026-07-01T00:00:00.000Z";
    mockErase.mockResolvedValue({
      requestId: "req-xyz",
      status: "queued",
      effectiveAt,
    });

    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    // Open confirming state
    fireEvent.click(
      screen.getByRole("button", { name: /delete organization/i }),
    );

    // Confirm the deletion
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /yes, delete organization/i }),
      );
    });

    expect(mockErase).toHaveBeenCalledWith(ORG_SLUG);

    // Should show the effective date (formatted via toLocaleDateString)
    await waitFor(() => {
      expect(
        screen.getByText(/organization deletion has been scheduled/i),
      ).toBeInTheDocument();
    });

    // The rendered date string must come from the effectiveAt value
    const expectedDate = new Date(effectiveAt).toLocaleDateString();
    expect(screen.getByText(expectedDate)).toBeInTheDocument();
  });

  // (9) Erase error: action rejects → error message
  it("shows an error message when requestOrgDataEraseAction rejects", async () => {
    mockErase.mockRejectedValue(new Error("Insufficient permissions"));

    render(<OrgPrivacyPanel orgSlug={ORG_SLUG} />);

    fireEvent.click(
      screen.getByRole("button", { name: /delete organization/i }),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /yes, delete organization/i }),
      );
    });

    expect(
      await screen.findByText(/insufficient permissions/i),
    ).toBeInTheDocument();
  });
});
