// @vitest-environment jsdom
// Organization › People › Invite, the write surface of send_workspace_invite:
// the form, the two answers that both changed the roster correctly, and the
// refusals. The case the design turns on is the second invitation for an email
// that is already pending: the handler answers with the row that already
// existed, so the dialog says "already invited" rather than reporting a failure
// for a call that did what was asked.
//
// The dialog asks for no workspace. The contract is named for one and is
// scoped, but its handler records an organization row with an organization
// role, so the negative here is that no workspace control and no workspace
// word reaches the screen.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, sendInvitation } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  sendInvitation: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  sendInvitation,
}));

const { InviteDialog } = await import("./invite-dialog");
const { Receipts } = await import("./receipt");
const { phoneWidth } = await import("@/test/phone");

const HERE = routes.people("acme");
/** The invitation the roster on screen already lists. */
const PENDING = "invi_4n5p6q7r8s9t0v1w2x3y4z";
/** The row a first invitation makes: an id the roster has never carried. */
const FRESH = "invi_9z8y7x6w5v4t3s2r1q0p9n";

const answered = (id: string) => ({
  ok: true as const,
  value: { id, status: "pending", expiresAt: "2026-09-27T12:00:00.000Z" },
});

function renderDialog(
  pendingIds: readonly string[] = [PENDING],
  allowed = true,
  twoFactorRequired = false,
) {
  return render(
    <IntlProvider>
      <InviteDialog
        org="acme"
        pendingIds={pendingIds}
        allowed={allowed}
        twoFactorRequired={twoFactorRequired}
        after={HERE}
      />
    </IntlProvider>,
  );
}

async function openForm(
  pendingIds: readonly string[] = [PENDING],
  twoFactorRequired = false,
) {
  renderDialog(pendingIds, true, twoFactorRequired);
  await userEvent.click(screen.getByRole("button", { name: "Invite" }));
  return screen.getByTestId("send-invitation");
}

async function fillAndSend(email: string, role?: string) {
  const dialog = await openForm();
  await userEvent.type(within(dialog).getByLabelText("Email"), email);
  if (role !== undefined) {
    await userEvent.selectOptions(within(dialog).getByLabelText("Role"), role);
  }
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Send the invitation" }),
  );
  return dialog;
}

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  sendInvitation.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("the form", () => {
  it("asks for an email and a role, the design's two fields, and for no workspace or note (negative)", async () => {
    const dialog = await openForm();
    expect(within(dialog).getByLabelText("Email")).toHaveAttribute(
      "type",
      "email",
    );
    const role = within(dialog).getByLabelText("Role");
    expect(
      within(role)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Member", "Admin", "Owner"]);
    expect(role).toHaveValue("member");
    expect(within(dialog).queryByLabelText(/note/i)).toBeNull();
    expect(dialog).toHaveTextContent(
      "An invitation is the only way into the organization. It expires in seven days, and accepting it requires a verified email.",
    );
    expect(dialog).not.toHaveTextContent("two-factor");
    expect(within(dialog).queryByLabelText(/workspace/i)).toBeNull();
    expect(
      within(dialog).queryByRole("combobox", { name: /workspace/i }),
    ).toBeNull();
  });

  it("sends nothing until it is submitted (negative)", async () => {
    await openForm();
    expect(sendInvitation).not.toHaveBeenCalled();
  });
});

describe("the two-factor policy", () => {
  it("says accepting asks for two-factor when the organization requires it", async () => {
    const dialog = await openForm([PENDING], true);
    expect(dialog).toHaveTextContent(
      "An invitation is the only way into the organization. It expires in seven days, and accepting it requires a verified email and two-factor.",
    );
  });
});

describe("an invitation that was made", () => {
  it("sends the email and the role, and says who was invited", async () => {
    sendInvitation.mockResolvedValue(answered(FRESH));
    const dialog = await openForm();
    await userEvent.type(
      within(dialog).getByLabelText("Email"),
      "dana.reyes@acme.example",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Role"),
      "admin",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Send the invitation" }),
    );
    expect(sendInvitation).toHaveBeenCalledWith("acme", {
      email: "dana.reyes@acme.example",
      role: "admin",
      message: "",
    });
    const panel = await screen.findByTestId("invitation-sent");
    expect(panel).toHaveTextContent("Invitation sent");
    expect(panel).toHaveTextContent(
      "dana.reyes@acme.example was invited as Admin.",
    );
    expect(screen.queryByTestId("invitation-already")).toBeNull();
  });

  it("holds the dialog while the write is in flight and says so on the button", async () => {
    let answer: (value: unknown) => void = () => {};
    sendInvitation.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const dialog = await fillAndSend("dana.reyes@acme.example");
    const submit = within(dialog).getByRole("button", { name: "Sending" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    answer(answered(FRESH));
    expect(await screen.findByTestId("invitation-sent")).toBeInTheDocument();
  });

  it("re-reads the pending table rather than patching it", async () => {
    sendInvitation.mockResolvedValue(answered(FRESH));
    await fillAndSend("dana.reyes@acme.example");
    await screen.findByTestId("invitation-sent");
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("an email that is already pending", () => {
  it("reads the row the handler returned as already invited, not as a failure", async () => {
    // The handler's insert conflicts and it answers with the pending row, so
    // the id comes back on the roster the page is already showing.
    sendInvitation.mockResolvedValue(answered(PENDING));
    await fillAndSend("dana.reyes@acme.example");
    const panel = await screen.findByTestId("invitation-already");
    expect(panel).toHaveTextContent("Already invited");
    expect(panel).toHaveTextContent(
      "dana.reyes@acme.example already has a pending invitation, so nothing changed.",
    );
    expect(screen.queryByTestId("send-invitation-failure")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("invitation-sent")).toBeNull();
  });

  it("still re-reads the table, because the roster is what the answer names", async () => {
    sendInvitation.mockResolvedValue(answered(PENDING));
    await fillAndSend("dana.reyes@acme.example");
    await screen.findByTestId("invitation-already");
    expect(router.replace).toHaveBeenCalledWith(HERE);
  });
});

describe("a refusal", () => {
  it("denied: names the role that makes this change and sends no second time (negative)", async () => {
    sendInvitation.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await fillAndSend("dana.reyes@acme.example");
    expect(
      await screen.findByTestId("send-invitation-failure"),
    ).toHaveTextContent("Denied. An owner or an admin makes this change.");
    expect(screen.queryByTestId("invitation-sent")).toBeNull();
    expect(screen.queryByTestId("invitation-already")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("invalid email: names the field the person has to fix", async () => {
    sendInvitation.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "email",
    });
    // The control is type="email", so the browser already refuses an address
    // with no "@". What reaches the action is an address the browser accepts
    // and the contract's schema does not, such as one with no top-level domain.
    await fillAndSend("dana.reyes@acme");
    expect(
      await screen.findByTestId("send-invitation-failure"),
    ).toHaveTextContent(
      "That is not an email address. Check the spelling and try again.",
    );
  });

  it("a role no invitation offers: names the three that are offered", async () => {
    sendInvitation.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "role_not_invitable",
      field: "role",
    });
    await fillAndSend("dana.reyes@acme.example");
    expect(
      await screen.findByTestId("send-invitation-failure"),
    ).toHaveTextContent(
      "That role is not one an invitation offers. Pick Member, Admin, or Owner.",
    );
  });

  it("a write that never answered is reported, not swallowed (negative)", async () => {
    sendInvitation.mockRejectedValue(new Error("network"));
    await fillAndSend("dana.reyes@acme.example");
    expect(
      await screen.findByTestId("send-invitation-failure"),
    ).toHaveTextContent(
      "The change could not be made: action_failed. Nothing was changed.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("a refused invitation can be corrected and sent again", async () => {
    sendInvitation.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "email",
    });
    const dialog = await fillAndSend("dana.reyes@acme");
    await screen.findByTestId("send-invitation-failure");
    sendInvitation.mockResolvedValueOnce(answered(FRESH));
    await userEvent.type(within(dialog).getByLabelText("Email"), ".example");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Send the invitation" }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("send-invitation-failure")).toBeNull();
    });
    expect(await screen.findByTestId("invitation-sent")).toBeInTheDocument();
  });
});

describe("a viewer who may not invite", () => {
  it("reads the refusal in place of the control, and opens nothing (negative)", () => {
    renderDialog([PENDING], false);
    expect(screen.getByTestId("invite-denied")).toHaveTextContent(
      "Inviting someone is an Owner and Admin action.",
    );
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByTestId("send-invitation")).toBeNull();
    expect(sendInvitation).not.toHaveBeenCalled();
  });
});

describe("the design's labels, the receipt and the phone", () => {
  it("is titled Invite a person and sends with Send the invitation", async () => {
    const dialog = await openForm();
    expect(
      within(dialog).getByRole("heading", { name: "Invite a person" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Send the invitation" }),
    ).toBeInTheDocument();
  });

  it("leaves a receipt naming the audit record once the invitation is sent", async () => {
    sendInvitation.mockResolvedValue(answered(FRESH));
    await fillAndSend("new@acme.example");
    render(
      <IntlProvider>
        <Receipts />
      </IntlProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("organization-receipts")).toHaveTextContent(
        "Invitation sent to new@acme.example. Recorded in the audit record.",
      );
    });
  });

  it("draws every input at 16px on a phone, so iOS does not zoom on focus", async () => {
    const phone = phoneWidth();
    try {
      const dialog = await openForm();
      const inputs = [
        within(dialog).getByLabelText("Email"),
        within(dialog).getByLabelText("Role"),
      ];
      for (const input of inputs) {
        expect(getComputedStyle(input).fontSize).toBe("16px");
        // The class list says so as well, for a reader of the markup.
        expect(input.className).toContain("max-md:text-base");
      }
    } finally {
      phone.restore();
    }
  });
});
