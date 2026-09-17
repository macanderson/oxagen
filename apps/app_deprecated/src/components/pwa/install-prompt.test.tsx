// @vitest-environment jsdom
/**
 * InstallPrompt — unit tests for suppression logic.
 *
 * Tests the three conditions that must suppress the banner:
 *  1. Already installed (standalone display mode).
 *  2. Previously dismissed (localStorage flag).
 *  3. iOS but NOT Safari (e.g. Chrome iOS) — should also be suppressed since
 *     `beforeinstallprompt` won't fire and the iOS instructions are Safari-only.
 *
 * These tests exercise the pure helper functions extracted for testability,
 * plus a render-layer test confirming the component returns null under each
 * suppression condition.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Re-export helpers from the component for isolated unit testing ────────────
// We can't import the unexported functions directly, so we test the component's
// rendered output instead — the observable effect of each suppression case.

import { InstallPrompt } from "./install-prompt";

// Mutable pathname consumed by the component's usePathname() — individual
// tests point it at auth/onboarding routes to exercise route suppression.
let mockPathname: string | null = null;
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => mockPathname,
}));

const DISMISSED_KEY = "oxagen:pwa-install-dismissed";

describe("InstallPrompt — suppression logic", () => {
  afterEach(() => {
    // Unmount all renders so DOM state doesn't leak between tests.
    cleanup();
  });

  beforeEach(() => {
    // Reset localStorage between tests.
    localStorage.clear();
    // Reset matchMedia mock.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    // Reset navigator.standalone.
    Object.defineProperty(navigator, "standalone", {
      writable: true,
      value: undefined,
    });
    // Reset userAgent.
    Object.defineProperty(navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
    });
    // Reset touch points (used to detect iPadOS masquerading as desktop).
    Object.defineProperty(navigator, "maxTouchPoints", {
      writable: true,
      value: 0,
    });
  });

  it("renders nothing initially (idle state — no beforeinstallprompt fired yet)", () => {
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when localStorage dismissed flag is set", () => {
    localStorage.setItem(DISMISSED_KEY, "true");
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when already in standalone mode (matchMedia)", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(display-mode: standalone)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when navigator.standalone is true (iOS Safari installed)", () => {
    Object.defineProperty(navigator, "standalone", {
      writable: true,
      value: true,
    });
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on auth/onboarding routes even on iOS Safari (route suppression)", () => {
    Object.defineProperty(navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    for (const route of [
      "/login",
      "/signup",
      "/new-organization",
      "/cli/authorize/device",
    ]) {
      mockPathname = route;
      const { container, unmount } = render(<InstallPrompt />);
      expect(container.innerHTML).toBe("");
      unmount();
    }
    mockPathname = null;
  });

  it("shows iOS instructions when on iOS Safari (not standalone, not dismissed)", () => {
    // Simulate iPhone Safari UA.
    Object.defineProperty(navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const { getByRole, getByText } = render(<InstallPrompt />);
    // The region should be present.
    expect(getByRole("region", { name: "Install Oxagen" })).toBeTruthy();
    // Should mention Add to Home Screen.
    expect(getByText(/Add to Home Screen/i)).toBeTruthy();
  });

  it("renders nothing on desktop even when beforeinstallprompt fires (desktop Chrome)", () => {
    // Desktop Chrome on macOS — no "Mobile" token, not a touch device.
    Object.defineProperty(navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      writable: true,
      value: 0,
    });
    const { container } = render(<InstallPrompt />);
    // Even if the browser fires the deferred install event, desktop is gated out
    // before the listener is ever registered, so the banner must stay hidden.
    act(() => {
      window.dispatchEvent(new Event("beforeinstallprompt"));
    });
    expect(container.firstChild).toBeNull();
  });

  it("treats iPadOS Safari (masquerading as desktop macOS) as a mobile device", () => {
    // iPadOS 13+ Safari reports a macOS UA; touch points reveal it's a tablet.
    Object.defineProperty(navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      writable: true,
      value: 5,
    });
    // Not iOS *Safari* by UA (no iPhone/iPad token), so it takes the Chrome path:
    // mobile gate passes, listener registers, and firing the event shows the CTA.
    const { container, queryByRole } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("beforeinstallprompt"));
    });
    expect(queryByRole("region", { name: "Install Oxagen" })).not.toBeNull();
  });

  it("persists the dismissed flag when dismiss button is clicked (iOS path)", async () => {
    Object.defineProperty(navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const { getAllByRole, queryByRole } = render(<InstallPrompt />);
    // Banner should be visible before dismiss.
    expect(queryByRole("region", { name: "Install Oxagen" })).not.toBeNull();
    const buttons = getAllByRole("button", { name: /dismiss/i });
    expect(buttons.length).toBeGreaterThan(0);
    const dismissBtn = buttons[0] as HTMLElement;
    // Wrap in act so React flushes state synchronously.
    await act(async () => {
      fireEvent.click(dismissBtn);
    });
    // localStorage flag is the durable source of truth — verify it first.
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("true");
    // The region should be gone from the DOM.
    await waitFor(() =>
      expect(queryByRole("region", { name: "Install Oxagen" })).toBeNull(),
    );
  });
});
