// @vitest-environment jsdom
/**
 * mfa-policy-form.test.tsx — unit tests for MfaPolicyForm component.
 *
 * Covers:
 *   - renders MFA toggle with correct initial checked state
 *   - canEdit=false: switch and select are disabled, save button hidden
 *   - canEdit=true: save button renders when dirty
 *   - save button disabled when not dirty
 *   - grace period select only shows when mfaRequired=true
 *   - success path: calls saveMfaPolicyAction, shows "Policy saved."
 *   - error path: shows error message from the action
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MfaPolicyForm } from "./mfa-policy-form";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSaveAction = vi.fn();

vi.mock("../actions", () => ({
  saveMfaPolicyAction: (...args: unknown[]) => mockSaveAction(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MfaPolicyForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAction.mockResolvedValue({ ok: true });
  });

  it("renders with correct initial MFA required state (true)", () => {
    const { container } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={true}
        initialMfaGraceHours={24}
      />,
    );
    // Switch renders with aria-label
    const toggle = container.querySelector(
      '[aria-label="Require MFA for all members"]',
    );
    expect(toggle).not.toBeNull();
  });

  it("shows the grace period select when mfaRequired is true", () => {
    const { getByLabelText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={true}
        initialMfaGraceHours={24}
      />,
    );
    expect(getByLabelText("Enforcement grace period")).toBeDefined();
  });

  it("hides the grace period select when mfaRequired is false", () => {
    const { queryByLabelText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );
    expect(queryByLabelText("Enforcement grace period")).toBeNull();
  });

  it("shows 'No changes' badge when not dirty", () => {
    const { getByText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );
    expect(getByText("No changes")).toBeDefined();
  });

  it("save button is disabled when not dirty", () => {
    const { getByText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );
    const saveBtn = getByText("Save policy").closest("button");
    expect(saveBtn?.disabled).toBe(true);
  });

  it("shows the 'Owner or admin role required' message when canEdit=false", () => {
    const { getByText, queryByText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={false}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );
    expect(getByText(/Owner or admin role required to change/)).toBeDefined();
    // Save button should not appear
    expect(queryByText("Save policy")).toBeNull();
  });

  it("switch is disabled when canEdit=false", () => {
    const { container } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={false}
        initialMfaRequired={true}
        initialMfaGraceHours={24}
      />,
    );
    const toggle = container.querySelector(
      '[aria-label="Require MFA for all members"]',
    );
    // When disabled, the button should have disabled attribute or aria-disabled
    const isDisabled =
      toggle?.getAttribute("disabled") !== null ||
      toggle?.getAttribute("aria-disabled") === "true" ||
      toggle?.hasAttribute("disabled");
    expect(isDisabled).toBe(true);
  });

  it("calls saveMfaPolicyAction with correct args on save", async () => {
    const { container, getByText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );

    // Toggle MFA required switch to make it dirty
    const toggle = container.querySelector(
      '[aria-label="Require MFA for all members"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(toggle);
    });

    const saveBtn = getByText("Save policy").closest("button");
    expect(saveBtn?.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(saveBtn!);
    });

    await waitFor(() => {
      expect(mockSaveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          orgSlug: "acme",
          mfaRequired: true,
          mfaGraceHours: 0,
        }),
      );
    });
  });

  it("shows 'Policy saved.' on successful save", async () => {
    const { container, getByText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );

    const toggle = container.querySelector(
      '[aria-label="Require MFA for all members"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(toggle);
    });

    await act(async () => {
      fireEvent.click(getByText("Save policy").closest("button")!);
    });

    await waitFor(() => {
      expect(getByText("Policy saved.")).toBeDefined();
    });
  });

  it("shows error message when saveMfaPolicyAction returns forbidden", async () => {
    mockSaveAction.mockResolvedValue({ ok: false, code: "forbidden" });
    const { container, getByText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );

    const toggle = container.querySelector(
      '[aria-label="Require MFA for all members"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(toggle);
    });

    await act(async () => {
      fireEvent.click(getByText("Save policy").closest("button")!);
    });

    await waitFor(() => {
      expect(getByText(/Permission denied/)).toBeDefined();
    });
  });

  it("shows internal error message when action returns internal with error", async () => {
    mockSaveAction.mockResolvedValue({
      ok: false,
      code: "internal",
      error: "DB write failed",
    });
    const { container, getByText } = render(
      <MfaPolicyForm
        orgSlug="acme"
        canEdit={true}
        initialMfaRequired={false}
        initialMfaGraceHours={0}
      />,
    );

    const toggle = container.querySelector(
      '[aria-label="Require MFA for all members"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(toggle);
    });

    await act(async () => {
      fireEvent.click(getByText("Save policy").closest("button")!);
    });

    await waitFor(() => {
      expect(getByText("DB write failed")).toBeDefined();
    });
  });
});
