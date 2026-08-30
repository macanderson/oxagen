// @vitest-environment jsdom
/**
 * delete-source-dialog.test.tsx — tests for the source-deletion confirmation.
 *
 * Covers:
 *   - Renders both delete modes with "full" selected by default.
 *   - Confirm with default mode → DELETE /connections/:id?mode=full.
 *   - Switching to "connection only" → DELETE ...?mode=connection_only.
 *   - Success toast + router.refresh on 200.
 *   - Error path surfaces the failure message and does not refresh.
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

const { mockAddToast, mockRefresh, radioState } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockRefresh: vi.fn(),
  radioState: { onChange: null as ((v: string) => void) | null },
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@oxagen/ui", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Dialog primitives → plain divs (skip Base UI portals/animation in jsdom).
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogPopup: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

// RadioGroup → capture onValueChange so tests can switch modes deterministically.
vi.mock("@/components/ui/radio-group", () => ({
  RadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => {
    radioState.onChange = onValueChange;
    return (
      <div data-testid="radio-group" data-value={value}>
        {children}
      </div>
    );
  },
  Radio: () => null,
}));

import { DeleteSourceDialog } from "./delete-source-dialog";

const TARGET = {
  publicId: "con_pub1",
  displayName: "Acme Repos",
  entityCount: 1234,
};

const BASE_PROPS = {
  open: true,
  onClose: vi.fn(),
  orgSlug: "acme",
  workspaceSlug: "main",
  target: TARGET,
};

function fetchCall(idx = 0) {
  const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[idx]!;
  return { url: call[0] as string, opts: call[1] as RequestInit };
}

beforeEach(() => {
  vi.clearAllMocks();
  radioState.onChange = null;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "running" }),
      text: async () => "",
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeleteSourceDialog", () => {
  it("renders both delete modes, defaulting to full", () => {
    render(<DeleteSourceDialog {...BASE_PROPS} />);
    expect(screen.getByTestId("delete-mode-full")).toBeTruthy();
    expect(screen.getByTestId("delete-mode-connection_only")).toBeTruthy();
    expect(screen.getByTestId("radio-group").getAttribute("data-value")).toBe(
      "full",
    );
    // The record count is surfaced in the "full" option label.
    expect(screen.getByText(/1,234 ingested records/)).toBeTruthy();
  });

  it("DELETEs with mode=full by default and refreshes on success", async () => {
    render(<DeleteSourceDialog {...BASE_PROPS} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-delete-source-btn"));
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const { url, opts } = fetchCall();
    expect(url).toBe("/api/v1/acme/main/connections/con_pub1?mode=full");
    expect(opts.method).toBe("DELETE");
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("DELETEs with mode=connection_only when that mode is selected", async () => {
    render(<DeleteSourceDialog {...BASE_PROPS} />);
    act(() => {
      radioState.onChange?.("connection_only");
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-delete-source-btn"));
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(fetchCall().url).toBe(
      "/api/v1/acme/main/connections/con_pub1?mode=connection_only",
    );
  });

  it("surfaces an error when the request fails and does not refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      }),
    );
    render(<DeleteSourceDialog {...BASE_PROPS} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-delete-source-btn"));
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("boom"),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });
});
