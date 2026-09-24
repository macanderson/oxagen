// @vitest-environment jsdom
// Organization › People and Organization › Invitations (pages/organization.md):
// the design's panels and columns in order, the cells no contract records
// saying "not recorded", the Open dialog with the member's facts, the row
// writes, Roles in use counted from the People table, and the Invitations
// table with Resend and Revoke. Checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberList } from "@/data/contracts/org";
import { expectNoAxe } from "@/test/expect-no-axe";
import { nth } from "@/test/nth";
import { IntlProvider } from "@/test/intl";
import { roleCatalog, roleRow } from "./organization.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  changeMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
  sendInvitation: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));

const { InvitationsTab, PeopleTab } = await import("./people");

afterEach(cleanup);

const roster: MemberList = {
  members: [
    {
      id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      name: "Marcus Bell",
      email: "marcus.bell@acme.example",
      role: "owner",
      joinedAt: "2026-03-02T09:15:00.000Z",
    },
    {
      id: "usr_0a1b2c3d4e5f6g7h8j9k0m",
      name: null,
      email: "ops@acme.example",
      role: "admin",
      joinedAt: "2026-05-11T16:40:00.000Z",
    },
    {
      id: "usr_1a1b2c3d4e5f6g7h8j9k0m",
      name: "Dana Okafor",
      email: "dana@acme.example",
      role: "admin",
      joinedAt: "2026-05-12T16:40:00.000Z",
    },
  ],
  invitations: [
    {
      id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
      email: "dana.reyes@acme.example",
      role: "admin",
      invitedAt: "2026-09-10T12:00:00.000Z",
      expiresAt: "2026-09-17T12:00:00.000Z",
    },
    {
      id: "invi_9z8y7x6w5v4t3s2r1q0p9n",
      email: "audit@acme.example",
      role: "compliance",
      invitedAt: "2026-09-01T08:00:00.000Z",
      expiresAt: null,
    },
  ],
};

const catalog = roleCatalog({
  roles: [
    roleRow({
      id: "rol_owner",
      name: "Owner",
      kind: "human",
      scope: "org",
      builtIn: true,
      description: "everything, including the data plane and funding",
    }),
    roleRow({
      id: "rol_admin",
      name: "Admin",
      kind: "human",
      description: null,
    }),
    roleRow(),
    roleRow({ id: "rol_other", name: "agent.graph.read" }),
  ],
});

/** The list row a member or invitation id keys. */
function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row="${id}"]`);
  if (row === null) throw new Error(`no row for ${id}`);
  return row;
}

function headers(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
}

describe("People", () => {
  async function renderPeople(
    members: MemberList = roster,
    twoFactorRequired = true,
  ) {
    const view = render(
      <IntlProvider>
        <PeopleTab
          org="acme"
          members={members}
          roles={catalog}
          twoFactorRequired={twoFactorRequired}
        />
      </IntlProvider>,
    );
    await expectNoAxe(view.container);
    return view;
  }

  it("draws the People panel with its badge, Invite, and the design's columns in order", async () => {
    await renderPeople();
    const panel = screen.getByRole("region", { name: "People" });
    expect(within(panel).getByText("two-factor required")).toHaveAttribute(
      "data-policy",
      "required",
    );
    expect(within(panel).getByRole("button", { name: "Invite" })).toBeTruthy();
    expect(
      headers(within(panel).getByRole("table", { name: "People" })),
    ).toEqual([
      "Person",
      "Role",
      "Workspaces",
      "Two-factor",
      "Last seen",
      "Status",
      // The row actions column has an empty header, as the design draws it,
      // and names itself to assistive tech.
      "",
    ]);
    expect(
      within(within(panel).getByRole("table", { name: "People" }))
        .getAllByRole("columnheader")
        .at(-1),
    ).toHaveAccessibleName("Actions");
    expect(within(panel).getByLabelText("Status")).toBeInTheDocument();
    // The design's Two-factor filter is drawn, and disabled with the reason,
    // because no contract records a member's method to filter on.
    const twoFactor = within(panel).getByLabelText("Two-factor");
    expect(twoFactor).toBeDisabled();
    expect(twoFactor).toHaveAccessibleDescription(
      "No contract records a member's two-factor method yet, so this filter cannot narrow the list.",
    );
    expect(
      within(twoFactor)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "All · Two-factor",
      "TOTP",
      "hardware key",
      "passkey",
      "passkey + TOTP",
    ]);
    expect(within(panel).getByLabelText("Rows")).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      "Changing a role is a governed action. It passes IAM and writes an audit record.",
    );
  });

  it("says two-factor is optional when the organization's policy does not require it", async () => {
    await renderPeople(roster, false);
    const panel = screen.getByRole("region", { name: "People" });
    expect(within(panel).getByText("two-factor optional")).toHaveAttribute(
      "data-policy",
      "optional",
    );
    expect(within(panel).queryByText("two-factor required")).toBeNull();
  });

  it("prints a member's name and email, the recorded role, active status, and not recorded where the roster has nothing", async () => {
    await renderPeople();
    const cells = within(rowOf("usr_7k2m9q4x8r1t5v3w6y0z2a")).getAllByRole(
      "cell",
    );
    expect(cells[0]).toHaveTextContent("Marcus Bell");
    expect(cells[0]).toHaveTextContent("marcus.bell@acme.example");
    expect(cells[1]).toHaveTextContent("Owner");
    for (const index of [2, 3, 4]) {
      expect(cells[index]).toHaveTextContent("not recorded");
    }
    expect(cells[5]).toHaveTextContent("active");
    expect(
      within(nth(cells, 6, "an actions cell"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Open", "Change role", "Remove"]);
  });

  it("opens a member's facts from Open", async () => {
    await renderPeople();
    const row = rowOf("usr_7k2m9q4x8r1t5v3w6y0z2a");
    await userEvent.click(within(row).getByRole("button", { name: "Open" }));
    const dialog = screen.getByTestId("member-usr_7k2m9q4x8r1t5v3w6y0z2a");
    // Titled with the person, the email beneath, as the design's `member` is.
    expect(
      within(dialog).getByRole("heading", { name: "Marcus Bell" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("marcus.bell@acme.example");
    expect(dialog).toHaveTextContent("usr_7k2m9q4x8r1t5v3w6y0z2a");
    expect(dialog).toHaveTextContent("not recorded");
  });

  it("draws the member dialog's Role per workspace, Agents they operate and Mandates, not recorded (#3932)", async () => {
    await renderPeople();
    const row = rowOf("usr_7k2m9q4x8r1t5v3w6y0z2a");
    await userEvent.click(within(row).getByRole("button", { name: "Open" }));
    const dialog = screen.getByTestId("member-usr_7k2m9q4x8r1t5v3w6y0z2a");
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Role per workspace", "Agents they operate", "Mandates"]);
    expect(
      within(dialog).getByRole("table", { name: "Role per workspace" }),
    ).toHaveTextContent("not recorded");
    expect(dialog.querySelector("[data-member-agents]")).toHaveTextContent(
      "not recorded",
    );
    expect(dialog).toHaveTextContent("Granted");
    expect(dialog).toHaveTextContent("Held by their agents");
    await expectNoAxe(dialog);
  });

  it("counts Roles in use from the People table, with each role's description", async () => {
    await renderPeople();
    const panel = screen.getByRole("region", { name: "Roles in use" });
    expect(
      within(panel).getByRole("link", { name: "Manage roles" }),
    ).toHaveAttribute("href", "/acme/roles");
    const owner = panel.querySelector('[data-role-in-use="owner"]');
    const admin = panel.querySelector('[data-role-in-use="admin"]');
    expect(owner).toHaveTextContent(
      "Owner1everything, including the data plane and funding",
    );
    expect(admin).toHaveTextContent("Admin2no description recorded");
    expect(panel).toHaveTextContent("2 agent roles are on the Roles tab.");
  });

  it("says the organization has no members when the roster is empty", async () => {
    await renderPeople({ members: [], invitations: [] });
    expect(
      screen.getByText("This organization has no members."),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("[data-row]")).toHaveLength(0);
  });
});

describe("Invitations", () => {
  async function renderInvitations(members: MemberList = roster) {
    const view = render(
      <IntlProvider>
        <InvitationsTab
          org="acme"
          members={members}
          twoFactorRequired={false}
        />
      </IntlProvider>,
    );
    await expectNoAxe(view.container);
    return view;
  }

  it("draws Pending invitations with Invite and the design's columns", async () => {
    await renderInvitations();
    const panel = screen.getByRole("region", { name: "Pending invitations" });
    expect(within(panel).getByRole("button", { name: "Invite" })).toBeTruthy();
    expect(
      headers(
        within(panel).getByRole("table", { name: "Pending invitations" }),
      ),
    ).toEqual(["Email", "Role offered", "Invited by", "Sent", "Expires", ""]);
  });

  it("prints each invitation with Invited by not recorded, and Resend and Revoke", async () => {
    await renderInvitations();
    const row = rowOf("invi_9z8y7x6w5v4t3s2r1q0p9n");
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("audit@acme.example");
    expect(cells[1]).toHaveTextContent("Compliance");
    expect(cells[2]).toHaveTextContent("not recorded");
    expect(cells[4]).toHaveTextContent("Never");
    expect(within(row).getByRole("button", { name: "Resend" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("filters by the day an invitation was sent and the day it expires", async () => {
    await renderInvitations();
    const panel = screen.getByRole("region", { name: "Pending invitations" });
    const sent = within(panel).getByLabelText("Sent");
    const expires = within(panel).getByLabelText("Expires");
    expect(
      within(sent)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All · Sent", "Sep 1, 2026", "Sep 10, 2026"]);
    expect(
      within(expires)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All · Expires", "Sep 17, 2026"]);
    await userEvent.selectOptions(sent, "Sep 10, 2026");
    expect(
      document.querySelector('[data-row="invi_4n5p6q7r8s9t0v1w2x3y4z"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-row="invi_9z8y7x6w5v4t3s2r1q0p9n"]'),
    ).toBeNull();
    await userEvent.selectOptions(sent, "");
    await userEvent.selectOptions(expires, "Sep 17, 2026");
    // An invitation that never expires falls outside any expiry day.
    expect(
      document.querySelector('[data-row="invi_9z8y7x6w5v4t3s2r1q0p9n"]'),
    ).toBeNull();
  });

  it("says no invitation is waiting when there are none", async () => {
    await renderInvitations({ members: roster.members, invitations: [] });
    expect(
      screen.getByText("No invitations are waiting for an answer."),
    ).toBeInTheDocument();
  });
});
