// @vitest-environment jsdom
// The Workspaces section's writes: create a workspace from the form this lane
// adds, rename and re-slug one, and archive one. Each reloads the page it
// changed; a refusal is named and nothing navigates.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, archiveWorkspace, createWorkspace, renameWorkspace } =
  vi.hoisted(() => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    archiveWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    renameWorkspace: vi.fn(),
  }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  archiveWorkspace,
  createWorkspace,
  renameWorkspace,
}));

const { workspaceRow } = await import("./organization.builders");
const { ArchiveWorkspace, CreateWorkspace, EditWorkspace } = await import(
  "./workspace-actions"
);

const workspace = workspaceRow();

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  archiveWorkspace.mockReset();
  createWorkspace.mockReset();
  renameWorkspace.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

async function open(name: string, testId: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByTestId(testId);
}

describe("CreateWorkspace", () => {
  // WL-62: the write answers with the new workspace's slug and the navigation
  // is its only reader — creating a workspace lands the operator in it.
  it("sends the name and the slug, then navigates to the new workspace's Fleet", async () => {
    createWorkspace.mockResolvedValue({
      ok: true,
      value: { slug: "research" },
    });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Research");
    await userEvent.type(within(dialog).getByLabelText("Slug"), "research");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research",
      slug: "research",
    });
    expect(router.replace).toHaveBeenCalledWith("/acme/research");
  });

  it("names a slug already taken and creates nothing (negative)", async () => {
    createWorkspace.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "slug_taken",
    });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Research");
    await userEvent.type(
      within(dialog).getByLabelText("Slug"),
      "core-platform",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );
    expect(
      await screen.findByTestId("create-workspace-failure"),
    ).toHaveTextContent("That slug is taken in this organization.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("EditWorkspace", () => {
  it("opens on the workspace's own name and slug and sends what changed", async () => {
    renameWorkspace.mockResolvedValue({ ok: true, value: { slug: "core" } });
    render(
      <IntlProvider>
        <EditWorkspace org="acme" workspace={workspace} />
      </IntlProvider>,
    );
    const dialog = await open(
      "Edit",
      "edit-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    const slug = within(dialog).getByLabelText("Slug");
    expect(slug).toHaveValue("core-platform");
    await userEvent.clear(slug);
    await userEvent.type(slug, "core");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(renameWorkspace).toHaveBeenCalledWith(
      "acme",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
      { name: "Core platform", slug: "core" },
    );
    expect(router.replace).toHaveBeenCalledWith("/acme");
  });
});

describe("ArchiveWorkspace", () => {
  it("archives the workspace and reloads the organization page", async () => {
    archiveWorkspace.mockResolvedValue({
      ok: true,
      value: { archivedAt: "2026-09-15T10:00:00.000Z" },
    });
    render(
      <IntlProvider>
        <ArchiveWorkspace org="acme" workspace={workspace} />
      </IntlProvider>,
    );
    const dialog = await open(
      "Archive",
      "archive-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(dialog).toHaveTextContent("Archive Core platform");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Archive" }),
    );
    expect(archiveWorkspace).toHaveBeenCalledWith(
      "acme",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(router.replace).toHaveBeenCalledWith("/acme");
  });

  it("names a workspace that still has agents and archives nothing (negative)", async () => {
    archiveWorkspace.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "workspace_has_agents",
    });
    render(
      <IntlProvider>
        <ArchiveWorkspace org="acme" workspace={workspace} />
      </IntlProvider>,
    );
    const dialog = await open(
      "Archive",
      "archive-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Archive" }),
    );
    expect(
      await screen.findByTestId(
        "archive-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m-failure",
      ),
    ).toHaveTextContent("Agents are still registered in this workspace.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
