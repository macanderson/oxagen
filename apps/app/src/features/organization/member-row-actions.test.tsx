// @vitest-environment jsdom
// A member's row: the member dialog, whose footer opens Change role, and the
// two writes. Each write dialog carries the design's title with the person as
// its subtitle and Cancel beside the confirm, calls its action for the member
// and the organization the page names, reloads the roster once the write
// answered, names every refusal without reloading, and renders the refusal in
// place of both buttons for a role that may not write membership.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberList } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, changeMemberRole, removeOrgMember } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  changeMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ changeMemberRole, removeOrgMember }));

const { MemberRowActions } = await import("./member-row-actions");

const HERE = routes.people("acme");
const member: MemberList["members"][number] = {
  id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
  avatarUrl: null,
  role: "billing",
  joinedAt: "2026-03-02T09:15:00.000Z",
};

function renderActions(
  overrides: Partial<MemberList["members"][number]> = {},
  allowed = true,
  details?: string,
) {
  render(
    <IntlProvider>
      <MemberRowActions
        org="acme"
        member={{ ...member, ...overrides }}
        allowed={allowed}
        after={HERE}
        details={details === undefined ? undefined : <p>{details}</p>}
      />
    </IntlProvider>,
  );
}

async function openDialog(open: string, testId: string) {
  await userEvent.click(screen.getByRole("button", { name: open }));
  return screen.getByTestId(testId);
}

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  changeMemberRole.mockReset();
  removeOrgMember.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("change role", () => {
  it("opens on the role they hold and grants the one chosen, then reloads the roster", async () => {
    changeMemberRole.mockResolvedValue({ ok: true, value: { role: "admin" } });
    renderActions();
    const dialog = await openDialog("Change role", "change-member-role");
    expect(within(dialog).getByRole("heading")).toHaveTextContent(
      /^Change role$/,
    );
    expect(dialog).toHaveTextContent("marcus.bell@acme.example");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .slice(-2),
    ).toEqual(["Cancel", "Change it"]);
    // The design's Person field, the header close, and its note.
    expect(within(dialog).getByLabelText("Person")).toHaveValue("Marcus Bell");
    expect(within(dialog).getByLabelText("Person")).toBeDisabled();
    expect(dialog.querySelector("[data-header-close]")).toHaveAccessibleName(
      "Close",
    );
    expect(dialog).toHaveTextContent(
      "A grant is a governed action, not a settings change.",
    );
    const picker = within(dialog).getByLabelText("Role");
    expect(picker).toHaveValue("billing");
    await userEvent.selectOptions(picker, "admin");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Change it" }),
    );
    expect(changeMemberRole).toHaveBeenCalledWith("acme", member.id, "admin");
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("offers the four roles this organization grants, and no other", async () => {
    renderActions();
    const dialog = await openDialog("Change role", "change-member-role");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["org.owner", "org.admin", "org.billing", "org.compliance"]);
  });

  it("opens on Admin for a member whose stored role this organization cannot grant", async () => {
    renderActions({ role: "member" });
    const dialog = await openDialog("Change role", "change-member-role");
    expect(within(dialog).getByLabelText("Role")).toHaveValue("admin");
  });
});

describe("remove", () => {
  it("removes the member and reloads the roster", async () => {
    removeOrgMember.mockResolvedValue({
      ok: true,
      value: { memberId: member.id },
    });
    renderActions();
    // The row's Remove is the design's `btn sm danger`.
    expect(screen.getByRole("button", { name: "Remove" }).className).toContain(
      "text-error-ink",
    );
    const dialog = await openDialog("Remove", "remove-member");
    expect(within(dialog).getByRole("heading")).toHaveTextContent(
      /^Remove from the organization$/,
    );
    expect(dialog).toHaveTextContent(
      "Marcus Bell loses org.billing and every workspace grant. Their sessions end now.",
    );
    // Which agents act for them is not recorded, and the note says so.
    expect(dialog).toHaveTextContent("#3932");
    // The design's `btn danger`: red ink on the confirm, never gold.
    const confirm = within(dialog).getByRole("button", { name: "Remove" });
    expect(confirm.className).toContain("text-error-ink");
    expect(confirm.className).not.toContain("bg-button-primary-bg");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .slice(-2),
    ).toEqual(["Cancel", "Remove"]);
    await userEvent.click(confirm);
    expect(removeOrgMember).toHaveBeenCalledWith("acme", member.id);
    expect(router.replace).toHaveBeenCalledWith(HERE);
  });

  it("names the person by their email when they never set a name", async () => {
    renderActions({ name: null });
    const dialog = await openDialog("Remove", "remove-member");
    expect(dialog).toHaveTextContent("marcus.bell@acme.example");
  });
});

describe("the member dialog", () => {
  it("shows the facts with Close and Change role, and Change role opens the role dialog", async () => {
    renderActions({}, true, "Org role facts");
    const dialog = await openDialog("Open", `member-${member.id}`);
    expect(dialog).toHaveTextContent("Org role facts");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .slice(-2),
    ).toEqual(["Close", "Change role"]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Change role" }),
    );
    expect(screen.queryByTestId(`member-${member.id}`)).toBeNull();
    const role = screen.getByTestId("change-member-role");
    expect(within(role).getByLabelText("Role")).toHaveValue("billing");
  });

  it("offers no Change role to a viewer who may not write membership (negative)", async () => {
    renderActions({}, false, "Org role facts");
    const dialog = await openDialog("Open", `member-${member.id}`);
    expect(
      within(dialog).queryByRole("button", { name: "Change role" }),
    ).toBeNull();
  });
});

describe("a refused write", () => {
  it.each([
    [
      { ok: false, reason: "conflict", code: "last_owner" },
      "This is the last owner of the organization. Make someone else an owner first.",
    ],
    [
      { ok: false, reason: "denied", code: "insufficient_role" },
      "Your organization role does not allow this change. Nothing was changed.",
    ],
    [
      { ok: false, reason: "denied", code: "no_principal" },
      "The request carried no signed-in user. Sign in and try again.",
    ],
    [
      { ok: false, reason: "denied", code: "capability_not_installed" },
      "The change was refused: capability_not_installed. Nothing was changed.",
    ],
    [
      { ok: false, reason: "not_found", code: "target_not_member" },
      "This person is no longer a member of this organization.",
    ],
    [
      {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "targetUserId",
      },
      "The request was refused as invalid. Nothing was changed.",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_1" },
      "The change is waiting for approval, request acr_1.",
    ],
    [
      { ok: false, reason: "unavailable", code: "kernel_failure" },
      "The change could not be made: kernel_failure. Nothing was changed.",
    ],
  ])(
    "is named in the dialog and reloads nothing (negative)",
    async (result, text) => {
      removeOrgMember.mockResolvedValue(result);
      renderActions();
      const dialog = await openDialog("Remove", "remove-member");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Remove" }),
      );
      expect(
        await screen.findByTestId("remove-member-failure"),
      ).toHaveTextContent(text);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      {
        ok: false,
        reason: "invalid",
        code: "role_not_grantable",
        field: "role",
      },
      "That role is not one this organization grants. Nothing was changed.",
    ],
    [
      { ok: false, reason: "not_found", code: "role_not_found" },
      "This organization has no role by that name. Nothing was changed.",
    ],
  ])("names a refused role change (negative)", async (result, text) => {
    changeMemberRole.mockResolvedValue(result);
    renderActions();
    const dialog = await openDialog("Change role", "change-member-role");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Change it" }),
    );
    expect(
      await screen.findByTestId("change-member-role-failure"),
    ).toHaveTextContent(text);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a write that threw before it answered (negative)", async () => {
    removeOrgMember.mockRejectedValue(new Error("network"));
    renderActions();
    const dialog = await openDialog("Remove", "remove-member");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove" }),
    );
    expect(
      await screen.findByTestId("remove-member-failure"),
    ).toHaveTextContent("The change could not be made: action_failed.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("closing the dialog forgets the refusal", async () => {
    removeOrgMember.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "last_owner",
    });
    renderActions();
    const dialog = await openDialog("Remove", "remove-member");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove" }),
    );
    expect(
      await screen.findByTestId("remove-member-failure"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByTestId("remove-member-failure")).toBeNull();
  });
});

describe("a role that may not write membership", () => {
  it("sees why, and neither write (negative)", () => {
    renderActions({}, false);
    expect(screen.getByTestId("member-actions-denied")).toHaveTextContent(
      "Changing a role and removing a member are Owner and Admin actions.",
    );
    expect(screen.queryByRole("button", { name: "Change role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
