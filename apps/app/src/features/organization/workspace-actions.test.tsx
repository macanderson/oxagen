// @vitest-environment jsdom
// The Workspaces section's writes: create a workspace from the form this lane
// adds, rename one, and archive one. Each reloads the page it changed; a
// refusal is named and nothing navigates. Create offers the repositories the
// organization's installations reach when it can read them, and a typed
// owner/name when it cannot.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
  readRepositoryChoices,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  editWorkspace: vi.fn(),
  readRepositoryChoices: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
}));
vi.mock("./workspace-reads", () => ({
  readRepositoryChoices,
}));

const { workspaceRow } = await import("./organization.builders");
const { Receipts } = await import("./receipt");
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
  readRepositoryChoices.mockReset();
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
  it("sends the name and the main repository, asks for no slug, then navigates to the new workspace's Fleet", async () => {
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
    // The design's form has no slug: the action makes it from the name.
    expect(within(dialog).queryByLabelText("Slug")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Research");
    await userEvent.type(
      within(dialog).getByLabelText("Main repository"),
      "acme/research",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research",
      mainRepo: "acme/research",
    });
    // With no workspace to read through, nothing asks GitHub.
    expect(readRepositoryChoices).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/acme/research");
    // The write leaves its receipt in the Organization frame's live region.
    render(
      <IntlProvider>
        <Receipts />
      </IntlProvider>,
    );
    expect(screen.getByTestId("organization-receipts")).toHaveTextContent(
      "The workspace was created. Recorded in the audit record.",
    );
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

  it("draws Production branch, Governance mode and Retention mode, and says which it cannot set yet", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" primary />
      </IntlProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Create a workspace" }),
    ).toHaveClass("bg-button-primary-bg");
    const dialog = await open("Create a workspace", "create-workspace");
    expect(within(dialog).getByLabelText("Production branch")).toBeDisabled();
    const mode = within(dialog).getByLabelText("Governance mode");
    expect(mode).toBeDisabled();
    expect(mode).toHaveAccessibleDescription(
      /Create a workspace takes no governance mode yet/,
    );
    expect(
      within(mode)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Leave unchanged",
      "solo · The author may merge their own.",
      "team · A code-owner review is required.",
      "regulated · A named approver from a role must approve, and the promotion ledger is hash-chained.",
    ]);
    expect(within(dialog).getByLabelText("Retention mode")).toHaveValue(
      "not recorded",
    );
    // The design asks for a namespace; create_workspace derives it, so the
    // field is read-only and says so.
    const namespace = within(dialog).getByLabelText("Namespace");
    expect(namespace).toBeDisabled();
    expect(namespace).toHaveAccessibleDescription(
      /derives it from the name when it creates the workspace/,
    );
  });

  it("offers the repositories the installations reach, and the branch create_workspace records for the one chosen", async () => {
    readRepositoryChoices.mockResolvedValue({
      ok: true,
      value: [
        { fullName: "acme/data-platform", defaultBranch: "main" },
        { fullName: "acme/warehouse", defaultBranch: "release" },
      ],
    });
    createWorkspace.mockResolvedValue({ ok: true, value: { slug: "data" } });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" enterable={["core-platform", "growth"]} />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    expect(readRepositoryChoices).toHaveBeenCalledWith("acme", [
      "core-platform",
      "growth",
    ]);
    const repo = await within(dialog).findByRole("combobox", {
      name: "Main repository",
    });
    await within(repo).findByRole("option", { name: "acme/warehouse" });
    expect(
      within(repo)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a repository", "acme/data-platform", "acme/warehouse"]);
    expect(repo).toHaveAccessibleDescription(
      "Required at creation. A workspace without a main repo cannot exist.",
    );
    const branch = within(dialog).getByLabelText("Production branch");
    expect(branch).toBeDisabled();
    await userEvent.selectOptions(repo, "acme/warehouse");
    expect(branch).toBeEnabled();
    expect(branch).toHaveTextContent("release — GitHub’s default, suggested");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Data");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Data",
      mainRepo: "acme/warehouse",
    });
  });

  it("falls back to a typed owner/name when no installation can be read (negative)", async () => {
    readRepositoryChoices.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "installation_unreachable",
    });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" enterable={["core-platform"]} />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    const field = await within(dialog).findByRole("textbox", {
      name: "Main repository",
    });
    expect(field).toHaveAccessibleDescription(/owner\/name on GitHub/);
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

  // A name that makes no valid slug is still "refused as invalid": the repository
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

  it("names an address already taken, as the name's, and creates nothing (negative)", async () => {
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
    await userEvent.type(
      within(dialog).getByLabelText("Name"),
      "Core platform",
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
    ).toHaveTextContent(
      "A workspace in this organization already has that address. Pick another name.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("EditWorkspace", () => {
  it("opens on the workspace's name, keeps its slug and sends what changed", async () => {
    editWorkspace.mockResolvedValue({
      ok: true,
      value: { slug: "core-platform", governance: null },
    });
    render(
      <IntlProvider>
        <EditWorkspace
          org="acme"
          workspace={workspace}
          facts={{
            repositories: [
              { role: "main", fullName: "acme/platform", defaultRef: "main" },
            ],
            agents: 64,
          }}
        />
      </IntlProvider>,
    );
    const dialog = await open(
      "Edit",
      "edit-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(
      within(dialog).getByRole("heading", { name: "Edit workspace" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("core-platform");
    // The design's Edit form has no slug field, and which repository is main
    // does not change from here (spec §10.1): the field is read-only, and
    // carries what list_repositories reports.
    expect(within(dialog).queryByLabelText("Slug")).toBeNull();
    const main = within(dialog).getByLabelText("Main repository");
    expect(main).toHaveAttribute("readonly");
    expect(main).toHaveValue("acme/platform");
    expect(main).toHaveAccessibleDescription(
      "Changing main is an org-owner action with approval.",
    );
    expect(within(dialog).getByLabelText("Production branch")).toHaveValue(
      "main",
    );
    expect(
      within(dialog).getByTestId("edit-workspace-agents"),
    ).toHaveTextContent("64 registered");
    expect(within(dialog).getByLabelText("Namespace")).toHaveValue(
      workspace.namespace,
    );
    expect(within(dialog).getByLabelText("Governance mode")).toHaveValue("");
    for (const fact of ["Toolbelt limit", "Default budget", "Agents"]) {
      expect(dialog).toHaveTextContent(fact);
    }
    const name = within(dialog).getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Core");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // The governance select was left on "leave unchanged", so the mode travels
    // empty and no governance capability is invoked (see
    // workspace-governance.test.tsx for the modes themselves).
    expect(editWorkspace).toHaveBeenCalledWith(
      "acme",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
      {
        name: "Core",
        slug: "core-platform",
        mode: "",
        applyImmediately: false,
      },
    );
    expect(router.replace).toHaveBeenCalledWith("/acme?tab=workspaces");
  });
});

describe("EditWorkspace without facts", () => {
  it("says not recorded for the main repository, the branch and the agents when the tab could not read them (negative)", async () => {
    render(
      <IntlProvider>
        <EditWorkspace org="acme" workspace={workspace} />
      </IntlProvider>,
    );
    const dialog = await open(
      "Edit",
      "edit-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(within(dialog).getByLabelText("Main repository")).toHaveValue(
      "not recorded",
    );
    expect(within(dialog).getByLabelText("Production branch")).toHaveValue(
      "not recorded",
    );
    expect(within(dialog).queryByTestId("edit-workspace-agents")).toBeNull();
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
    expect(
      within(dialog).getByRole("heading", { name: "Archive workspace" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Core platform");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Archive" }),
    );
    expect(archiveWorkspace).toHaveBeenCalledWith(
      "acme",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(router.replace).toHaveBeenCalledWith("/acme?tab=workspaces");
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
