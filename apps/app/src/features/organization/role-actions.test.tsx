// @vitest-environment jsdom
// The role editor's writes: each dialog sends what its fields carry, reloads
// the Roles page once the write answered, and names a refusal without
// navigating. The permission picker ticks what the role already allows.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, createRole, deleteRole, setRolePermissions } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    createRole: vi.fn(),
    deleteRole: vi.fn(),
    setRolePermissions: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ createRole, deleteRole, setRolePermissions }));

const { permissionEntry, roleRow } = await import("./organization.builders");
const { CreateRole, DeleteRole, EditRole } = await import("./role-actions");

const catalog = [
  permissionEntry(),
  permissionEntry({
    permission: "budget.set",
    group: "Money",
    description: "Read and set spend budgets and the budget policy",
    capabilities: ["get_spend_budget"],
  }),
];

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  createRole.mockReset();
  deleteRole.mockReset();
  setRolePermissions.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

async function open(name: string, testId: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByTestId(testId);
}

describe("CreateRole", () => {
  it("sends the name, the scope and every ticked permission, then reloads the page", async () => {
    createRole.mockResolvedValue({
      ok: true,
      value: { id: "rol_1", name: "agent.release" },
    });
    render(
      <IntlProvider>
        <CreateRole org="acme" catalog={catalog} />
      </IntlProvider>,
    );
    const dialog = await open("Create role", "create-role");
    await userEvent.type(
      within(dialog).getByLabelText("Name"),
      "agent.release",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Scope"),
      "workspace",
    );
    await userEvent.click(within(dialog).getByLabelText(/run\.read/));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createRole).toHaveBeenCalledWith("acme", {
      name: "agent.release",
      description: "",
      scope: "workspace",
      permissions: ["run.read"],
    });
    expect(router.replace).toHaveBeenCalledWith("/acme/roles");
  });

  it("names a refusal and stays where it is (negative)", async () => {
    createRole.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "role_exists",
    });
    render(
      <IntlProvider>
        <CreateRole org="acme" catalog={catalog} />
      </IntlProvider>,
    );
    const dialog = await open("Create role", "create-role");
    await userEvent.type(within(dialog).getByLabelText("Name"), "agent.release");
    await userEvent.click(within(dialog).getByLabelText(/run\.read/));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );
    expect(await screen.findByTestId("create-role-failure")).toHaveTextContent(
      "That name is taken in this organization. Pick another.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("EditRole", () => {
  it("opens with what the role already allows and sends the new set", async () => {
    setRolePermissions.mockResolvedValue({
      ok: true,
      value: { id: "rol_7k2m9q4x8r1t5v3w6y0z2a", name: "agent.release" },
    });
    render(
      <IntlProvider>
        <EditRole org="acme" role={roleRow()} catalog={catalog} />
      </IntlProvider>,
    );
    const dialog = await open("Edit", "edit-role-rol_7k2m9q4x8r1t5v3w6y0z2a");
    expect(within(dialog).getByLabelText(/run\.read/)).toBeChecked();
    expect(within(dialog).getByLabelText(/budget\.set/)).not.toBeChecked();
    await userEvent.click(within(dialog).getByLabelText(/budget\.set/));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(setRolePermissions).toHaveBeenCalledWith(
      "acme",
      "rol_7k2m9q4x8r1t5v3w6y0z2a",
      ["run.read", "budget.set"],
    );
    expect(router.replace).toHaveBeenCalledWith("/acme/roles");
  });

  it("names a ceiling refusal and changes nothing (negative)", async () => {
    setRolePermissions.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "delegation_ceiling_exceeded",
    });
    render(
      <IntlProvider>
        <EditRole org="acme" role={roleRow()} catalog={catalog} />
      </IntlProvider>,
    );
    const dialog = await open("Edit", "edit-role-rol_7k2m9q4x8r1t5v3w6y0z2a");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await screen.findByTestId(
        "edit-role-rol_7k2m9q4x8r1t5v3w6y0z2a-failure",
      ),
    ).toHaveTextContent("A role cannot grant more than you hold.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("DeleteRole", () => {
  it("deletes the role and reloads the page", async () => {
    deleteRole.mockResolvedValue({
      ok: true,
      value: { id: "rol_7k2m9q4x8r1t5v3w6y0z2a", name: "agent.release" },
    });
    render(
      <IntlProvider>
        <DeleteRole org="acme" role={roleRow()} />
      </IntlProvider>,
    );
    const dialog = await open(
      "Delete",
      "delete-role-rol_7k2m9q4x8r1t5v3w6y0z2a",
    );
    expect(dialog).toHaveTextContent("Delete agent.release");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );
    expect(deleteRole).toHaveBeenCalledWith(
      "acme",
      "rol_7k2m9q4x8r1t5v3w6y0z2a",
    );
    expect(router.replace).toHaveBeenCalledWith("/acme/roles");
  });

  it("names a role someone still holds and deletes nothing (negative)", async () => {
    deleteRole.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "role_in_use",
    });
    render(
      <IntlProvider>
        <DeleteRole org="acme" role={roleRow()} />
      </IntlProvider>,
    );
    const dialog = await open(
      "Delete",
      "delete-role-rol_7k2m9q4x8r1t5v3w6y0z2a",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );
    expect(
      await screen.findByTestId(
        "delete-role-rol_7k2m9q4x8r1t5v3w6y0z2a-failure",
      ),
    ).toHaveTextContent("Principals still hold this role.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
