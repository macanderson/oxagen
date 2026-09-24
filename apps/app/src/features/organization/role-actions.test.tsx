// @vitest-environment jsdom
// The role editor `roleedit` and the delete dialog `roledel`
// (pages/organization-roles.md): one editor behind Create role, Edit, View and
// Duplicate. Each write sends what its fields carry, reloads the Roles page
// once the write answered, and names a refusal without navigating. The
// selected count follows the ticks, a held role carries the holders banner,
// and a built-in role opens read-only with Duplicate as custom.
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
const { DeleteRole, RoleEditor } = await import("./role-actions");
const { Receipts } = await import("./receipt");

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

function editor(
  mode: "create" | "duplicate" | "edit" | "view",
  role?: ReturnType<typeof roleRow>,
  openLabel = "Create role",
) {
  render(
    <IntlProvider>
      <RoleEditor
        org="acme"
        catalog={catalog}
        mode={mode}
        openLabel={openLabel}
        {...(role === undefined ? {} : { role })}
      />
    </IntlProvider>,
  );
}

describe("RoleEditor: create", () => {
  it("sends the name, the description, the scope and every ticked permission, then reloads Roles", async () => {
    createRole.mockResolvedValue({
      ok: true,
      value: { id: "rol_1", name: "agent.release" },
    });
    editor("create");
    const dialog = await open("Create role", "role-editor-create");
    expect(dialog).toHaveTextContent("Create a role");
    expect(within(dialog).getByTestId("role-selected-count")).toHaveTextContent(
      "0 selected",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Role name"),
      "agent.release",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Description"),
      "cut a release after approval",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Scope"),
      "org",
    );
    await userEvent.click(within(dialog).getByLabelText(/run\.read/));
    expect(within(dialog).getByTestId("role-selected-count")).toHaveTextContent(
      "1 selected",
    );
    expect(dialog).toHaveTextContent(
      "Saving is a governed action. It passes IAM and writes an audit record.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create role" }),
    );
    expect(createRole).toHaveBeenCalledWith("acme", {
      name: "agent.release",
      description: "cut a release after approval",
      scope: "org",
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
    editor("create");
    const dialog = await open("Create role", "role-editor-create");
    await userEvent.type(
      within(dialog).getByLabelText("Role name"),
      "agent.release",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create role" }),
    );
    expect(await screen.findByTestId("role-editor-failure")).toHaveTextContent(
      "That name is taken in this organization. Pick another.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("RoleEditor: edit", () => {
  const id = "rol_7k2m9q4x8r1t5v3w6y0z2a";

  it("opens on what the role allows, names its holders and sends the new set", async () => {
    setRolePermissions.mockResolvedValue({
      ok: true,
      value: { id, name: "agent.release" },
    });
    editor("edit", roleRow(), "Edit");
    const dialog = await open("Edit", `role-editor-edit-${id}`);
    expect(within(dialog).getByLabelText("Role name")).toHaveAttribute(
      "readonly",
    );
    expect(within(dialog).getByLabelText(/run\.read/)).toBeChecked();
    expect(within(dialog).getByLabelText(/budget\.set/)).not.toBeChecked();
    expect(within(dialog).getByTestId("role-holders-banner")).toHaveTextContent(
      "Held by 2 principals. Saving changes their effective permission at the next call",
    );
    await userEvent.click(within(dialog).getByLabelText(/budget\.set/));
    expect(within(dialog).getByTestId("role-selected-count")).toHaveTextContent(
      "2 selected",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(setRolePermissions).toHaveBeenCalledWith("acme", id, [
      "run.read",
      "budget.set",
    ]);
    expect(router.replace).toHaveBeenCalledWith("/acme/roles");
    render(
      <IntlProvider>
        <Receipts />
      </IntlProvider>,
    );
    expect(screen.getByTestId("organization-receipts")).toHaveTextContent(
      "was saved. Each holder's permission changes at their next call. Recorded in the audit record.",
    );
  });

  it("names a ceiling refusal and changes nothing (negative)", async () => {
    setRolePermissions.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "delegation_ceiling_exceeded",
    });
    editor("edit", roleRow(), "Edit");
    const dialog = await open("Edit", `role-editor-edit-${id}`);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(await screen.findByTestId("role-editor-failure")).toHaveTextContent(
      "A role cannot grant more than you hold.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("RoleEditor: view and duplicate", () => {
  const builtIn = roleRow({
    id: "rol_builtin00000000000000",
    name: "org.owner",
    kind: "human",
    scope: "org",
    builtIn: true,
    heldBy: 0,
  });

  it("opens a built-in role read-only, with no save, and Duplicate as custom turns it into a copy", async () => {
    createRole.mockResolvedValue({
      ok: true,
      value: { id: "rol_2", name: "org.owner.copy" },
    });
    editor("view", builtIn, "View");
    const dialog = await open("View", `role-editor-view-${builtIn.id}`);
    expect(dialog).toHaveTextContent("Built-in role");
    expect(dialog).toHaveTextContent("read-only");
    expect(within(dialog).getByLabelText(/run\.read/)).toBeDisabled();
    expect(
      within(dialog).queryByRole("button", { name: "Save changes" }),
    ).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Duplicate as custom" }),
    );
    const copy = screen.getByTestId(`role-editor-duplicate-${builtIn.id}`);
    expect(within(copy).getByLabelText("Role name")).toHaveValue(
      "org.owner.copy",
    );
    await userEvent.click(
      within(copy).getByRole("button", { name: "Create role" }),
    );
    expect(createRole).toHaveBeenCalledWith("acme", {
      name: "org.owner.copy",
      description: builtIn.description,
      scope: "org",
      permissions: ["run.read"],
    });
  });

  it("opens Duplicate as a new role named after the original", async () => {
    editor("duplicate", roleRow(), "Duplicate");
    const dialog = await open(
      "Duplicate",
      `role-editor-duplicate-${roleRow().id}`,
    );
    expect(within(dialog).getByLabelText("Role name")).toHaveValue(
      "agent.release.copy",
    );
    expect(within(dialog).queryByTestId("role-holders-banner")).toBeNull();
  });
});

describe("DeleteRole", () => {
  const free = roleRow({ heldBy: 0 });

  it("deletes a role nobody holds and reloads the page", async () => {
    deleteRole.mockResolvedValue({
      ok: true,
      value: { id: free.id, name: "agent.release" },
    });
    render(
      <IntlProvider>
        <DeleteRole org="acme" role={free} />
      </IntlProvider>,
    );
    const dialog = await open("Delete", `delete-role-${free.id}`);
    expect(dialog).toHaveTextContent("Delete role");
    expect(dialog).toHaveTextContent("This removes agent.release from IAM.");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete role" }),
    );
    expect(deleteRole).toHaveBeenCalledWith("acme", free.id);
    expect(router.replace).toHaveBeenCalledWith("/acme/roles");
    render(
      <IntlProvider>
        <Receipts />
      </IntlProvider>,
    );
    expect(screen.getByTestId("organization-receipts")).toHaveTextContent(
      "agent.release was deleted. Its definition and grants stay in the audit record.",
    );
  });

  it("names a refusal and deletes nothing (negative)", async () => {
    deleteRole.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "role_in_use",
    });
    render(
      <IntlProvider>
        <DeleteRole org="acme" role={free} />
      </IntlProvider>,
    );
    const dialog = await open("Delete", `delete-role-${free.id}`);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete role" }),
    );
    expect(
      await screen.findByTestId(`delete-role-${free.id}-failure`),
    ).toHaveTextContent("Principals still hold this role.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("disables Delete on a built-in role and on a held one, with the reason (negative)", () => {
    render(
      <IntlProvider>
        <DeleteRole org="acme" role={roleRow({ builtIn: true, heldBy: 0 })} />
        <DeleteRole org="acme" role={roleRow({ id: "rol_held", heldBy: 3 })} />
      </IntlProvider>,
    );
    expect(
      screen.getByRole("button", {
        name: "Delete: Built-in roles cannot be deleted",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Delete: Reassign the 3 holders first",
      }),
    ).toBeDisabled();
    expect(deleteRole).not.toHaveBeenCalled();
  });
});
