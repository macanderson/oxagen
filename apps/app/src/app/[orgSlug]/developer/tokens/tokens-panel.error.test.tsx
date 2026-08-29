// @vitest-environment jsdom
/**
 * tokens-panel.error.test.tsx — a failing server action has to reach the user.
 *
 * If an action on this panel runs inside `startTransition` with no catch, a
 * rejected `rotateApiKeyAction` is swallowed by React: the transition ends,
 * no state changes, and the previously-displayed secret stays on screen. A
 * rotation that fails then looks identical to one that worked, and an e2e
 * spec that notices can only report "the key did not change" without being
 * able to say why.
 *
 * These tests assert the failure is visible, which is what makes the next
 * diagnosis a glance rather than an investigation.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const rotate = vi.fn();
const revoke = vi.fn();
const create = vi.fn();

vi.mock("./api-key", () => ({
  rotateApiKeyAction: (...args: unknown[]) => rotate(...args),
  revokeApiKeyAction: (...args: unknown[]) => revoke(...args),
  createApiKeyAction: (...args: unknown[]) => create(...args),
}));

const { TokensPanel } = await import("./tokens-panel");
type ApiKeyRow = import("./tokens-panel").ApiKeyRow;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Annotated, not a bare literal: ApiKeyRow gained `scope` and `deletedAt`, and
// an unannotated fixture would have kept compiling while drifting from the type
// it stands in for. That is the failure ADR-037 is about, and this fixture hit
// it — typecheck caught it in CI, which is the ADR working.
const KEY: ApiKeyRow = {
  publicId: "key_1",
  name: "e2e key",
  keyPrefix: "ox_abcdefgh",
  scope: null,
  createdAt: new Date("2026-01-01").toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  deletedAt: null,
};

describe("TokensPanel — a rejected action surfaces", () => {
  it("shows the failure when rotation rejects, instead of leaving the old secret up", async () => {
    rotate.mockRejectedValue(new Error("rotation refused: insufficient scope"));
    render(<TokensPanel orgSlug="acme" keys={[KEY]} />);

    await userEvent.click(screen.getByTitle("Rotate key"));

    await waitFor(() =>
      expect(screen.getByTestId("api-key-action-error")).toHaveTextContent(
        "rotation refused: insufficient scope",
      ),
    );
  });

  it("falls back to a generic message when the rejection carries none", async () => {
    rotate.mockRejectedValue(new Error(""));
    render(<TokensPanel orgSlug="acme" keys={[KEY]} />);

    await userEvent.click(screen.getByTitle("Rotate key"));

    await waitFor(() =>
      expect(screen.getByTestId("api-key-action-error")).toHaveTextContent(
        "Something went wrong.",
      ),
    );
  });

  it("says nothing when rotation succeeds", async () => {
    rotate.mockResolvedValue({ rawKey: "ox_new", name: "e2e key" });
    render(<TokensPanel orgSlug="acme" keys={[KEY]} />);

    await userEvent.click(screen.getByTitle("Rotate key"));

    await waitFor(() => expect(screen.getByText("ox_new")).toBeInTheDocument());
    expect(
      screen.queryByTestId("api-key-action-error"),
    ).not.toBeInTheDocument();
  });
});
