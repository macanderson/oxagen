// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import { expectNoAxe } from "@/test/expect-no-axe";
const mocks = vi.hoisted(() => ({
  resend: vi.fn(),
  revoke: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./actions", () => ({
  resendInvitation: mocks.resend,
  revokeInvitation: mocks.revoke,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
import { InvitationControls } from "./invitation-controls";
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resend.mockResolvedValue({ ok: true, value: {} });
  mocks.revoke.mockResolvedValue({ ok: true, value: {} });
});
function show(allowed = true) {
  return render(
    <IntlProvider>
      <InvitationControls
        org="acme"
        invitationId="invi_abc"
        allowed={allowed}
      />
    </IntlProvider>,
  );
}
describe("invitation controls", () => {
  it("renders readable disabled controls without authority", async () => {
    const { container } = show(false);
    expect(screen.getByRole("button", { name: "Resend" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeDisabled();
    await expectNoAxe(container);
  });
  it("keeps a refused resend retryable and refreshes only after success", async () => {
    const user = userEvent.setup();
    show();
    mocks.resend.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "offline",
    });
    await user.click(screen.getByRole("button", { name: "Resend" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.resend).toHaveBeenCalledWith("acme", "invi_abc");
    expect(screen.getByRole("status")).toHaveTextContent("email sent");
  });
  it("prevents a resend during revoke and after its successful answer", async () => {
    let finish: ((value: unknown) => void) | undefined;
    mocks.revoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    const { container } = show();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("button", { name: "Resend" })).toBeDisabled();
    await expectNoAxe(container);
    finish?.({ ok: true, value: {} });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("revoked"),
    );
    expect(screen.getByRole("button", { name: "Resend" })).toBeDisabled();
    expect(mocks.resend).not.toHaveBeenCalled();
  });
  it("reports a thrown write and leaves the row usable", async () => {
    mocks.revoke.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    const { container } = show();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled();
    await expectNoAxe(container);
  });
});
