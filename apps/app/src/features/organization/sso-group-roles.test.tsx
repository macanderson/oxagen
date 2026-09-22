// @vitest-environment jsdom
// One provider's IdP group mapping editor on the Roles page.
//
// The cases the design turns on:
//   - rows are added and removed here, and Save sends the whole table,
//     because `set_sso_group_roles` keeps exactly the rows it is sent;
//   - the role select never offers owner;
//   - a refused row is named on that row;
//   - a viewer who cannot write sees the rows with no control.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoGroupRole } from "@/data/contracts/org";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, setSsoGroupRoles } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  setSsoGroupRoles: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./sso-actions", () => ({ setSsoGroupRoles }));

const { SsoGroupRoles } = await import("./sso-group-roles");

const MAPPED: SsoGroupRole[] = [
  { group: "oxagen-admins", role: "admin" },
  { group: "finance", role: "billing" },
];

function renderEditor(
  mappings: readonly SsoGroupRole[] = MAPPED,
  canEdit = true,
) {
  return render(
    <IntlProvider>
      <SsoGroupRoles
        org="acme"
        providerId="acme-okta"
        providerName="Acme Okta"
        mappings={mappings}
        canEdit={canEdit}
      />
    </IntlProvider>,
  );
}

const save = () =>
  userEvent.click(screen.getByRole("button", { name: "Save mappings" }));

beforeEach(() => {
  setSsoGroupRoles.mockReset();
  router.refresh.mockReset();
  setSsoGroupRoles.mockResolvedValue({ ok: true, value: { mappings: [] } });
});
afterEach(cleanup);

describe("SsoGroupRoles", () => {
  it("shows each mapped group with its role", async () => {
    const { container } = renderEditor();
    expect(
      screen.getByRole("textbox", { name: "Group name, row 1" }),
    ).toHaveValue("oxagen-admins");
    expect(screen.getByRole("combobox", { name: "Role, row 2" })).toHaveValue(
      "billing",
    );
    await expectNoAxe(container);
  });

  it("offers admin, compliance, billing and member, and never owner (negative)", () => {
    renderEditor();
    const select = screen.getByRole("combobox", { name: "Role, row 1" });
    const values = within(select)
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));
    expect(values).toEqual(["admin", "compliance", "billing", "member"]);
    expect(values).not.toContain("owner");
  });

  it("adds a row and sends the whole table, the new row included", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add row" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Group name, row 3" }),
      "auditors",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Role, row 3" }),
      "compliance",
    );
    await save();
    await waitFor(() => {
      expect(setSsoGroupRoles).toHaveBeenCalledWith("acme", "acme-okta", [
        { group: "oxagen-admins", role: "admin" },
        { group: "finance", role: "billing" },
        { group: "auditors", role: "compliance" },
      ]);
    });
    expect(
      await screen.findByTestId("sso-groups-acme-okta-saved"),
    ).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("removes a row and sends the table without it", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    await save();
    await waitFor(() => {
      expect(setSsoGroupRoles).toHaveBeenCalledWith("acme", "acme-okta", [
        { group: "finance", role: "billing" },
      ]);
    });
  });

  it("sends an empty table when every row is removed", async () => {
    renderEditor([{ group: "finance", role: "billing" }]);
    await userEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(screen.getByTestId("sso-groups-acme-okta-empty")).toBeTruthy();
    await save();
    await waitFor(() => {
      expect(setSsoGroupRoles).toHaveBeenCalledWith("acme", "acme-okta", []);
    });
  });

  it("names a refused row on that row (negative)", async () => {
    setSsoGroupRoles.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "group_duplicate",
      field: "mappings.1.group",
    });
    renderEditor();
    await save();
    const row2 = await screen.findByRole("textbox", {
      name: "Group name, row 2",
    });
    await waitFor(() => {
      expect(row2).toHaveAttribute("aria-invalid", "true");
    });
    expect(
      screen.getByText(
        "This group already has a row. Give each group one role.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Group name, row 1" }),
    ).not.toHaveAttribute("aria-invalid");
  });

  it("names a whole-table refusal once (negative)", async () => {
    setSsoGroupRoles.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    renderEditor();
    await save();
    expect(
      await screen.findByTestId("sso-groups-acme-okta-failure"),
    ).toHaveTextContent("Only an Owner or an Admin can change single sign-on.");
  });

  it("shows a viewer who cannot write the rows and no control (negative)", async () => {
    const { container } = renderEditor(MAPPED, false);
    expect(screen.getByText("oxagen-admins")).toBeTruthy();
    expect(screen.getByText("Billing")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    await expectNoAxe(container);
  });
});
