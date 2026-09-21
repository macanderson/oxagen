// @vitest-environment jsdom
// The Workspaces section's writes: create a workspace from the form this lane
// adds, rename and re-slug one, and archive one. Each reloads the page it
// changed; a refusal is named and nothing navigates.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, archiveWorkspace, createWorkspace, editWorkspace } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    archiveWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    editWorkspace: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
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
  editWorkspace.mockReset();
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
  // M0 (spec §17): the draft carries the main repository, as typed, so the
  // action is the one place that splits it.
  it("sends the name, the slug and the main repository, then navigates to the new workspace's Fleet", async () => {
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
    await userEvent.type(
      within(dialog).getByLabelText("Main repository"),
      "acme/research",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research",
      slug: "research",
      mainRepo: "acme/research",
    });
    expect(router.replace).toHaveBeenCalledWith("/acme/research");
  });

  // The person names a repository and nothing else: the hint says the
  // installation is found from the owner, and no installation picker exists.
  it("asks for the main repository as owner/name, with the installation rule as its hint", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    const field = within(dialog).getByLabelText("Main repository");
    expect(field).toBeRequired();
    expect(field).toHaveAccessibleDescription(/owner\/name on GitHub/);
    expect(field).toHaveAccessibleDescription(
      /finds the installation from the owner/,
    );
    expect(within(dialog).queryByLabelText(/installation/i)).toBeNull();
  });

  it.each([
    [
      "repository_unparsable",
      {
        ok: false,
        reason: "invalid",
        code: "repository_unparsable",
        field: "mainRepo",
      },
      "Write it as owner/name.",
    ],
    [
      "invalid_input on mainRepo.name",
      {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "mainRepo.name",
      },
      "Write it as owner/name.",
    ],
    [
      "github_not_authorized",
      { ok: false, reason: "conflict", code: "github_not_authorized" },
      "has not connected GitHub",
    ],
    [
      "installation_unreachable",
      { ok: false, reason: "not_found", code: "installation_unreachable" },
      "not installed on that owner",
    ],
    [
      "repository_not_installed",
      { ok: false, reason: "not_found", code: "repository_not_installed" },
      "cannot see that repository",
    ],
    [
      "main_repo_claimed",
      { ok: false, reason: "conflict", code: "main_repo_claimed" },
      "Another workspace already steers by that repository.",
    ],
    [
      "repository_linked_elsewhere",
      { ok: false, reason: "conflict", code: "repository_linked_elsewhere" },
      "Another workspace has linked that repository",
    ],
  ])(
    "names a main repository refused as %s and creates nothing (negative)",
    async (_reason, refusal, sentence) => {
      createWorkspace.mockResolvedValue(refusal);
      render(
        <IntlProvider>
          <CreateWorkspace org="acme" />
        </IntlProvider>,
      );
      const dialog = await open("Create a workspace", "create-workspace");
      await userEvent.type(within(dialog).getByLabelText("Name"), "Research");
      await userEvent.type(within(dialog).getByLabelText("Slug"), "research");
      await userEvent.type(
        within(dialog).getByLabelText("Main repository"),
        "acme/research",
      );
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Create" }),
      );
      expect(
        await screen.findByTestId("create-workspace-failure"),
      ).toHaveTextContent(sentence);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  // A blank name or slug is still "refused as invalid": the repository
  // sentence names one field and must not be shown for another.
  it("keeps the generic invalid sentence for a field other than the repository (negative)", async () => {
    createWorkspace.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "slug",
    });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Research");
    await userEvent.type(within(dialog).getByLabelText("Slug"), "research");
    await userEvent.type(
      within(dialog).getByLabelText("Main repository"),
      "acme/research",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );
    expect(
      await screen.findByTestId("create-workspace-failure"),
    ).toHaveTextContent("The request was refused as invalid.");
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
    await userEvent.type(
      within(dialog).getByLabelText("Main repository"),
      "acme/research",
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
    editWorkspace.mockResolvedValue({
      ok: true,
      value: { slug: "core", governance: null },
    });
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
    // Which repository is main does not change from here (spec §10.1).
    expect(within(dialog).queryByLabelText("Main repository")).toBeNull();
    await userEvent.clear(slug);
    await userEvent.type(slug, "core");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // The governance radio was left on "leave unchanged", so the mode travels
    // empty and no governance capability is invoked (see
    // workspace-governance.test.tsx for the modes themselves).
    expect(editWorkspace).toHaveBeenCalledWith(
      "acme",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
      {
        name: "Core platform",
        slug: "core",
        mode: "",
        applyImmediately: false,
      },
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
