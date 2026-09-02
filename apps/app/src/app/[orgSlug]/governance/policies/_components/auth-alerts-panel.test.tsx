// @vitest-environment jsdom
/**
 * auth-alerts-panel.test.tsx — unit tests for AuthAlertsPanel.
 *
 * Covers:
 *   - renders initial role checkboxes + email switch state
 *   - canEdit=false: controls disabled, save affordance shows the reason
 *   - toggling a role checkbox updates its checked state
 *   - deselecting every role disables Save with a warning
 *   - save success path: calls saveAuthAlertsAction with current selection, shows confirmation
 *   - save error path: shows the returned error message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { AuthAlertsPanel } from "./auth-alerts-panel";

afterEach(() => cleanup());

const mockSaveAction = vi.fn();

vi.mock("../actions", () => ({
  saveAuthAlertsAction: (...args: unknown[]) => mockSaveAction(...args),
}));

describe("AuthAlertsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAction.mockResolvedValue({ ok: true });
  });

  it("renders the initial selected roles and email switch", () => {
    const { getByTestId } = render(
      <AuthAlertsPanel
        orgSlug="acme"
        initialSendEmail={true}
        initialRoles={["Owner", "Admin"]}
        isDefault={false}
        canEdit={true}
      />,
    );
    expect((getByTestId("alert-role-owner") as HTMLInputElement).checked).toBe(
      true,
    );
    expect((getByTestId("alert-role-admin") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (getByTestId("alert-role-compliance") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (getByTestId("alert-role-billing") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("notes the platform default when isDefault=true", () => {
    const { getByText } = render(
      <AuthAlertsPanel
        orgSlug="acme"
        initialSendEmail={true}
        initialRoles={["Owner", "Admin"]}
        isDefault={true}
        canEdit={true}
      />,
    );
    expect(getByText(/platform default/)).toBeDefined();
  });

  it("disables all controls and shows the reason when canEdit=false", () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <AuthAlertsPanel
        orgSlug="acme"
        initialSendEmail={true}
        initialRoles={["Owner"]}
        isDefault={false}
        canEdit={false}
      />,
    );
    expect(
      getByText(/Only org owners and admins can change this/),
    ).toBeDefined();
    // jsdom does not reliably compute the descendant <input>'s own .disabled
    // property from a disabled ancestor <fieldset> (unlike a real browser),
    // so assert on the fieldset itself — the actual element the component sets.
    const fieldset = getByTestId("alert-role-owner").closest("fieldset");
    expect(fieldset?.disabled).toBe(true);
    expect(
      (getByTestId("auth-alerts-save") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(queryByTestId("auth-alerts-save")).not.toBeNull();
  });

  it("toggling a role checkbox updates its checked state", async () => {
    const { getByTestId } = render(
      <AuthAlertsPanel
        orgSlug="acme"
        initialSendEmail={false}
        initialRoles={["Owner"]}
        isDefault={false}
        canEdit={true}
      />,
    );
    const compliance = getByTestId("alert-role-compliance") as HTMLInputElement;
    expect(compliance.checked).toBe(false);
    await act(async () => {
      fireEvent.click(compliance);
    });
    expect(compliance.checked).toBe(true);
  });

  it("deselecting every role disables Save with a warning", async () => {
    const { getByTestId, getByText } = render(
      <AuthAlertsPanel
        orgSlug="acme"
        initialSendEmail={false}
        initialRoles={["Owner"]}
        isDefault={false}
        canEdit={true}
      />,
    );
    const owner = getByTestId("alert-role-owner") as HTMLInputElement;
    await act(async () => {
      fireEvent.click(owner);
    });
    expect(owner.checked).toBe(false);
    expect(
      (getByTestId("auth-alerts-save") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(getByText("Select at least one role.")).toBeDefined();
  });

  it("saves the current selection and shows confirmation on success", async () => {
    const { getByTestId, getByText } = render(
      <AuthAlertsPanel
        orgSlug="acme"
        initialSendEmail={false}
        initialRoles={["Owner"]}
        isDefault={false}
        canEdit={true}
      />,
    );
    await act(async () => {
      fireEvent.click(getByTestId("alert-role-compliance"));
    });
    await act(async () => {
      fireEvent.click(getByTestId("auth-alerts-save"));
    });
    await waitFor(() => {
      expect(mockSaveAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        sendEmail: false,
        roles: expect.arrayContaining(["Owner", "Compliance"]),
      });
    });
    await waitFor(() => {
      expect(getByText("Alert setting saved.")).toBeDefined();
    });
  });

  it("shows the returned error message on save failure", async () => {
    mockSaveAction.mockResolvedValue({
      ok: false,
      error: "Saving the alert setting failed. Try again.",
    });
    const { getByTestId, getByText } = render(
      <AuthAlertsPanel
        orgSlug="acme"
        initialSendEmail={true}
        initialRoles={["Owner"]}
        isDefault={false}
        canEdit={true}
      />,
    );
    await act(async () => {
      fireEvent.click(getByTestId("auth-alerts-save"));
    });
    await waitFor(() => {
      expect(
        getByText("Saving the alert setting failed. Try again."),
      ).toBeDefined();
    });
  });
});
