// @vitest-environment jsdom
/**
 * api-key-display.test.tsx — render + interaction tests for ApiKeyDisplay.
 *
 * Covers:
 *   - Renders the API key name
 *   - Renders the raw key value
 *   - Renders "Created" date
 *   - Renders "Expires" when expiresAt is provided
 *   - Does not render "Expires" when expiresAt is null
 *   - Renders Copy button
 *   - Copy button shows Check icon after click (clipboard write)
 *   - Renders "Save this key securely" security notice
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiKeyDisplay } from "./api-key-display";

afterEach(cleanup);

// Mock clipboard API
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: writeTextMock },
  writable: true,
});

// Mock toast
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

const defaultProps = {
  keyId: "key-id-1",
  publicId: "pub-1",
  name: "Production API Key",
  rawKey: "oxagen_key_abc123xyz",
  createdAt: "2025-01-15T00:00:00Z",
  expiresAt: null,
};

describe("ApiKeyDisplay — rendering", () => {
  it("renders the key name", () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    expect(screen.getByText("Production API Key")).toBeInTheDocument();
  });

  it("renders the raw key value as code", () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    expect(screen.getByText("oxagen_key_abc123xyz")).toBeInTheDocument();
  });

  it("renders the created date", () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    expect(screen.getByText(/created/i)).toBeInTheDocument();
  });

  it("renders 'Expires' when expiresAt is set", () => {
    render(
      <ApiKeyDisplay {...defaultProps} expiresAt="2026-01-15T00:00:00Z" />,
    );
    expect(screen.getByText(/expires/i)).toBeInTheDocument();
  });

  it("does not render 'Expires' when expiresAt is null", () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    expect(screen.queryByText(/expires/i)).not.toBeInTheDocument();
  });

  it("renders the Copy button", () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    expect(
      screen.getByRole("button", { name: /copy api key/i }),
    ).toBeInTheDocument();
  });

  it("renders the security notice", () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    expect(screen.getByText(/save this key securely/i)).toBeInTheDocument();
  });
});

describe("ApiKeyDisplay — copy interaction", () => {
  it("copies the raw key to clipboard when Copy is clicked", async () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    await userEvent.click(
      screen.getByRole("button", { name: /copy api key/i }),
    );
    expect(writeTextMock).toHaveBeenCalledWith("oxagen_key_abc123xyz");
  });

  it("shows 'Copied' aria-label after click", async () => {
    render(<ApiKeyDisplay {...defaultProps} />);
    await userEvent.click(
      screen.getByRole("button", { name: /copy api key/i }),
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: /copied/i }),
        ).toBeInTheDocument(),
      { timeout: 1000 },
    );
  });
});
