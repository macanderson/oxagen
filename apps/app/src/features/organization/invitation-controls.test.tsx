// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  mocks.resend.mockResolvedValue({ ok: true, value: { delivery: "accepted" } });
  mocks.revoke.mockResolvedValue({ ok: true, value: {} });
});
function show(allowed = true) {
  return render(
    <IntlProvider>
      <InvitationControls
        org="acme"
        invitationId="invi_abc"
        email="ada@acme.example"
        allowed={allowed}
      />
    </IntlProvider>,
  );
}
const dialog = () => screen.getByTestId("revoke-invitation-invi_abc");
const confirmButton = () =>
  within(dialog()).getByRole("button", { name: "Revoke" });

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
    await waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledOnce();
    });
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
    expect(mocks.revoke).not.toHaveBeenCalled();
    await user.click(confirmButton());
    expect(
      screen.getByRole("button", { name: "Resend", hidden: true }),
    ).toBeDisabled();
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
    expect(mocks.revoke).not.toHaveBeenCalled();
    await user.click(confirmButton());
    // The refusal is named in the dialog, which stays open to retry or cancel.
    expect(await within(dialog()).findByRole("alert")).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled();
    await expectNoAxe(container);
  });
});

it("reports renewed expiry when mail delivery fails and keeps resend available", async () => {
  mocks.resend.mockResolvedValueOnce({
    ok: true,
    value: { delivery: "failed" },
  });
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole("button", { name: "Resend" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "now expires in seven days, but its email could not be sent",
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Resend" })).toBeEnabled();
});
it("allows cancelling invitation revocation without a write", async () => {
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(screen.queryByTestId("revoke-invitation-invi_abc")).toBeNull();
});

it("opens the design's revoke dialog: the email, its body, and Cancel then a red Revoke", async () => {
  const user = userEvent.setup();
  show();
  const opener = screen.getByRole("button", { name: "Revoke" });
  // The row's Revoke is the design's `btn sm danger`.
  expect(opener.className).toContain("text-error-ink");
  await user.click(opener);
  const shown = dialog();
  expect(within(shown).getByRole("heading")).toHaveTextContent(
    /^Revoke invitation$/,
  );
  expect(shown).toHaveTextContent(
    "The link stops working the moment this is revoked, and ada@acme.example gets no notice.",
  );
  expect(shown).toHaveTextContent("Inviting them again issues a new link.");
  expect(
    within(shown)
      .getAllByRole("button")
      .map((button) => button.textContent)
      .slice(-2),
  ).toEqual(["Cancel", "Revoke"]);
  expect(confirmButton().className).toContain("text-error-ink");
  expect(confirmButton().className).not.toContain("bg-button-primary-bg");
  expect(shown.querySelector("[data-header-close]")).not.toBeNull();
  await expectNoAxe(document.body);
});
