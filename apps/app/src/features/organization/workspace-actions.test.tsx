// @vitest-environment jsdom
// The Workspaces section's writes: create a workspace from the form this lane
// adds, rename one, and archive one. Each reloads the page it changed; a
// refusal is named and nothing navigates. Create asks for a label, a name
// (the slug), a cost center, and the steering repo's place and name (#5196).
// It then holds the dialog open on the steering repo's provisioning steps,
// says when the repo is ready, and opens repository selection in the new
// workspace.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { renderToaster } from "@/test/toaster";

const {
  router,
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
  readSteeringRepoDestinations,
  readWorkspaceSteeringRepo,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  editWorkspace: vi.fn(),
  readSteeringRepoDestinations: vi.fn(),
  readWorkspaceSteeringRepo: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
  readSteeringRepoDestinations,
  readWorkspaceSteeringRepo,
}));
// The provisioning steps' own retry and import, which these tests never press.
vi.mock("@/features/steering-repo/actions", () => ({
  importWorkspaceSteering: vi.fn(),
  readSteeringRepoDestinations: vi.fn(),
  repairSteeringRepo: vi.fn(),
  retrySteeringRepoProvision: vi.fn(),
}));

/** The new workspace's steering repo while the job runs, and once it is done. */
const PROVISIONING = {
  status: "provisioning",
  step: "create_repository",
  failedStep: null,
  error: null,
  provider: "github",
  repository: null,
  publishedVersion: null,
  health: null,
  differences: [],
  legacySource: null,
  connection: { provider: "github", id: 12, name: "acme", kind: "organization" },
  requestedName: null,
  connectionChoices: [],
  importRun: null,
};
const READY = {
  ...PROVISIONING,
  status: "ready",
  step: "bind_repository",
  repository: {
    fullName: "acme/oxagen-research",
    url: "https://github.com/acme/oxagen-research",
  },
  publishedVersion: 1,
  health: "healthy",
};

/** What `createWorkspace` answers for Research, charged to `research`. */
const CREATED = {
  publicId: "wrk_research",
  slug: "research",
  name: "Research",
  steeringRepo: "provisioning",
  costCenter: { ok: true, code: "research" },
};

const NO_PLACES = {
  destinations: [],
  default: null,
  defaultName: null,
  reauthorize: [],
};

const { workspaceFacts, workspaceRow } = await import(
  "./organization.builders"
);
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
  readSteeringRepoDestinations
    .mockReset()
    .mockResolvedValue({ ok: true, value: NO_PLACES });
  readWorkspaceSteeringRepo
    .mockReset()
    .mockResolvedValue({ ok: true, value: PROVISIONING });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

async function open(name: string, testId: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByTestId(testId);
}

/** Opens Create a workspace, types the label, and presses Create. */
async function create(label = "Research") {
  render(
    <IntlProvider>
      <CreateWorkspace org="acme" />
    </IntlProvider>,
  );
  const dialog = await open("Create a workspace", "create-workspace");
  await userEvent.type(within(dialog).getByLabelText("Label"), label);
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  return dialog;
}

describe("CreateWorkspace", () => {
  it("asks for a label, a name, the cost center, and the steering repo's name, and offers no code repository", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" primary />
      </IntlProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Create a workspace" }),
    ).toHaveClass("bg-button-primary-bg");
    const dialog = await open("Create a workspace", "create-workspace");
    expect(within(dialog).getByLabelText("Label")).toBeRequired();
    expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
    // The places load when the dialog opens. With nothing connected there is
    // no Organization select.
    expect(readSteeringRepoDestinations).toHaveBeenCalledWith("acme");
    await within(dialog).findByTestId("create-workspace-steering-connection-none");
    // The cost center is the name until the box is unticked.
    expect(
      within(dialog).getByRole("checkbox", {
        name: "Use name as the workspace's cost center code",
      }),
    ).toBeChecked();
    expect(
      within(dialog).queryByLabelText("Workspace cost center code"),
    ).toBeNull();
    // Oxagen makes the steering repo, so the form offers no code repository.
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(3);
    expect(within(dialog).getByLabelText("Repository name")).not.toBeRequired();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    for (const gone of [
      "Main repository",
      "Production branch",
      "Governance mode",
      "Retention mode",
      "Namespace",
    ]) {
      expect(within(dialog).queryByLabelText(gone)).toBeNull();
    }
  });

  it("draws each field's help as a gold button that says the name is the slug", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    const label = within(dialog).getByRole("button", { name: "Help for Label" });
    const name = within(dialog).getByRole("button", { name: "Help for Name" });
    for (const help of [label, name]) {
      expect(help).toHaveClass("bg-button-primary-bg");
      expect(help).toHaveClass("text-button-primary-fg");
    }
    await userEvent.click(name);
    expect(
      await screen.findByTestId("create-workspace-slug-help-note"),
    ).toHaveTextContent("Oxagen uses the name as the workspace's slug");
  });

  it("fills the name in from the label as a slug, and keeps a name the person types", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    const label = within(dialog).getByLabelText("Label");
    const name = within(dialog).getByLabelText("Name");
    const repo = within(dialog).getByLabelText("Repository name");
    await userEvent.type(label, "Mac's R&D Team");
    expect(label).toHaveValue("Mac's R&D Team");
    expect(name).toHaveValue("macs-rd-team");
    expect(repo).toHaveValue("oxagen-macs-rd-team");
    // A typed name keeps lowercase letters, digits and hyphens only.
    await userEvent.clear(name);
    await userEvent.type(name, "Research Lab!");
    expect(name).toHaveValue("research-lab");
    expect(repo).toHaveValue("oxagen-research-lab");
    // The label no longer moves it.
    await userEvent.type(label, " two");
    expect(name).toHaveValue("research-lab");
  });

  it("names a slug the contract would refuse under the name (negative)", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    await userEvent.type(within(dialog).getByLabelText("Label"), "X");
    await userEvent.tab();
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("x");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Use at least 2 characters.");
    if (!(name instanceof HTMLInputElement))
      throw new Error("the name is not an input");
    expect(name.validity.valid).toBe(false);
  });

  // WL-62: the write answers with the new workspace's slug, and closing the
  // panel before setup finishes lands the operator in it.
  it("sends the label, the name, the cost center and the repository name, then shows the setup steps in place of the form", async () => {
    // The root layout's toaster, where the receipt lands (ADR-221).
    renderToaster();
    createWorkspace.mockResolvedValue({ ok: true, value: CREATED });
    const dialog = await create();
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research",
      slug: "research",
      costCenter: "research",
      steeringRepo: { name: "oxagen-research" },
    });
    const done = await within(dialog).findByTestId("create-workspace-done");
    expect(within(done).getByTestId("create-workspace-done-name")).toHaveTextContent(
      "Research research",
    );
    expect(within(done).getByTestId("create-workspace-cost-center")).toHaveTextContent(
      "research",
    );
    // The steps the Repositories page's setup dialog draws, read in the new
    // workspace.
    const steps = await within(done).findByTestId("steering-repo-provisioning");
    expect(steps).toHaveAttribute("data-status", "provisioning");
    expect(readWorkspaceSteeringRepo).toHaveBeenCalledWith("acme", "research");
    expect(within(done).queryByTestId("create-workspace-ready")).toBeNull();
    // The form gave way to the result: no Create is left to press twice.
    expect(within(dialog).queryByRole("button", { name: "Create" })).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("toasts")).toHaveTextContent(
        "The workspace was created. Recorded in the audit record.",
      );
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(router.replace).toHaveBeenCalledWith("/acme/research");
  });

  it("reads the steps again until the repo is ready, then says so", async () => {
    createWorkspace.mockResolvedValue({ ok: true, value: CREATED });
    readWorkspaceSteeringRepo
      .mockResolvedValueOnce({ ok: true, value: PROVISIONING })
      .mockResolvedValue({ ok: true, value: READY });
    const dialog = await create();
    const ready = await within(dialog).findByTestId(
      "create-workspace-ready",
      {},
      { timeout: 6_000 },
    );
    expect(ready).toHaveTextContent(
      "Your workspace is ready. Next, pick the repositories it steers.",
    );
    expect(readWorkspaceSteeringRepo).toHaveBeenCalledTimes(2);
  }, 12_000);

  it("opens repository selection in the new workspace once the repo is ready", async () => {
    createWorkspace.mockResolvedValue({ ok: true, value: CREATED });
    readWorkspaceSteeringRepo.mockResolvedValue({ ok: true, value: READY });
    const dialog = await create();
    await within(dialog).findByTestId("create-workspace-ready");
    await waitFor(
      () => {
        expect(router.replace).toHaveBeenCalledWith(
          routes.addRepository("acme", "research"),
        );
      },
      { timeout: 4_000 },
    );
    expect(routes.addRepository("acme", "research")).toBe(
      "/acme/research/repositories?add=repository",
    );
    // Leaving is not closing: the Fleet is not opened on top of it.
    expect(router.replace).not.toHaveBeenCalledWith("/acme/research");
    await waitFor(() => {
      expect(screen.queryByTestId("create-workspace")).toBeNull();
    });
  }, 10_000);

  it("opens repository selection at once from Pick repositories", async () => {
    createWorkspace.mockResolvedValue({ ok: true, value: CREATED });
    readWorkspaceSteeringRepo.mockResolvedValue({ ok: true, value: READY });
    const dialog = await create();
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Pick repositories" }),
    );
    expect(router.replace).toHaveBeenCalledWith(
      routes.addRepository("acme", "research"),
    );
  });

  it("says a setup read that failed and keeps the dialog open (negative)", async () => {
    createWorkspace.mockResolvedValue({ ok: true, value: CREATED });
    readWorkspaceSteeringRepo.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "get_steering_repo",
    });
    const dialog = await create();
    expect(
      await within(dialog).findByTestId("create-workspace-steering-reading"),
    ).toHaveTextContent("Oxagen could not read the setup (get_steering_repo)");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("charges a code the person types when the box is unticked", async () => {
    createWorkspace.mockResolvedValue({
      ok: true,
      value: { ...CREATED, costCenter: { ok: true, code: "ENG-1001" } },
    });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    await userEvent.type(within(dialog).getByLabelText("Label"), "Research");
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Use name as the workspace's cost center code",
      }),
    );
    const code = within(dialog).getByLabelText("Workspace cost center code");
    expect(code).toHaveValue("");
    expect(
      within(dialog).getByRole("button", {
        name: "Help for Workspace cost center code",
      }),
    ).toBeInTheDocument();
    await userEvent.type(code, "ENG-1001");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createWorkspace).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ costCenter: "ENG-1001" }),
    );
  });

  it("names a cost-center code the list would refuse under the field (negative)", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Use name as the workspace's cost center code",
      }),
    );
    const code = within(dialog).getByLabelText("Workspace cost center code");
    await userEvent.type(code, "-eng");
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveAccessibleDescription(/Use up to 64 letters/);
    if (!(code instanceof HTMLInputElement))
      throw new Error("the cost center code is not an input");
    expect(code.validity.valid).toBe(false);
  });

  it("says a cost center that was not set beside the workspace that was made (negative)", async () => {
    createWorkspace.mockResolvedValue({
      ok: true,
      value: {
        ...CREATED,
        costCenter: { ok: false, code: "research", reason: "denied" },
      },
    });
    const dialog = await create();
    expect(
      await within(dialog).findByTestId("create-workspace-cost-center"),
    ).toHaveTextContent("Not set to research. Oxagen answered denied.");
    expect(within(dialog).getByTestId("create-workspace-done-name")).toHaveTextContent(
      "Research",
    );
  });

  // A slug the contract refuses for a reason the form cannot see is refused
  // as invalid, and the generic sentence is the one shown.
  it("keeps the generic invalid sentence for a refusal the form cannot name (negative)", async () => {
    createWorkspace.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "slug",
    });
    await create();
    expect(
      await screen.findByTestId("create-workspace-failure"),
    ).toHaveTextContent("The request was refused as invalid.");
    expect(screen.queryByTestId("create-workspace-done")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names an address already taken, and creates nothing (negative)", async () => {
    createWorkspace.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "slug_taken",
    });
    await create("Core platform");
    expect(
      await screen.findByTestId("create-workspace-failure"),
    ).toHaveTextContent(
      "A workspace in this organization already has that address. Pick another name.",
    );
    expect(screen.queryByTestId("create-workspace-done")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("starts the Organization select on the default and sends the pick", async () => {
    readSteeringRepoDestinations.mockResolvedValue({
      ok: true,
      value: {
        destinations: [
          { provider: "github", id: 12, name: "acme", kind: "organization" },
          { provider: "github", id: 22, name: "acme-labs", kind: "organization" },
        ],
        default: { provider: "github", id: 12, name: "acme", kind: "organization" },
        defaultName: null,
        reauthorize: [],
      },
    });
    createWorkspace.mockResolvedValue({ ok: true, value: CREATED });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    const select = await within(dialog).findByTestId(
      "create-workspace-steering-connection",
    );
    expect(select).toHaveValue("github:12");
    await userEvent.selectOptions(select, "github:22");
    const label = within(dialog).getByLabelText("Label");
    const repo = within(dialog).getByLabelText("Repository name");
    await userEvent.type(label, "Research");
    expect(repo).toHaveValue("oxagen-research");
    await userEvent.clear(repo);
    await userEvent.type(repo, "research-steering");
    await userEvent.type(label, " lab");
    expect(repo).toHaveValue("research-steering");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research lab",
      slug: "research-lab",
      costCenter: "research-lab",
      steeringRepo: {
        name: "research-steering",
        connection: { provider: "github", id: 22 },
      },
    });
  });

  it("still creates the workspace when the places do not load (negative)", async () => {
    readSteeringRepoDestinations.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "list_steering_repo_destinations",
    });
    createWorkspace.mockResolvedValue({ ok: true, value: CREATED });
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    expect(
      await within(dialog).findByTestId(
        "create-workspace-steering-connection-failed",
      ),
    ).toHaveTextContent("The organizations did not load");
    await userEvent.type(within(dialog).getByLabelText("Label"), "Research");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research",
      slug: "research",
      costCenter: "research",
      steeringRepo: { name: "oxagen-research" },
    });
  });

  it("names a repository name the contract would refuse under the field (negative)", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" />
      </IntlProvider>,
    );
    const dialog = await open("Create a workspace", "create-workspace");
    await userEvent.type(within(dialog).getByLabelText("Label"), "Research");
    const repo = within(dialog).getByLabelText("Repository name");
    await userEvent.clear(repo);
    await userEvent.type(repo, "-research");
    expect(repo).toHaveAttribute("aria-invalid", "true");
    expect(repo).toHaveAccessibleDescription(/Use up to 100 letters/);
    if (!(repo instanceof HTMLInputElement))
      throw new Error("the repository name is not an input");
    expect(repo.validity.valid).toBe(false);
  });

  it("names a write that threw and stays on the form (negative)", async () => {
    createWorkspace.mockRejectedValue(new Error("network"));
    await create();
    expect(
      await screen.findByTestId("create-workspace-failure"),
    ).not.toBeEmptyDOMElement();
    expect(screen.queryByTestId("create-workspace-done")).toBeNull();
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
          facts={workspaceFacts()}
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
    // The design's `wsBranch` select, holding the one branch recorded:
    // edit_workspace takes no branch, so it cannot be changed from here.
    const branch = within(dialog).getByLabelText("Production branch");
    expect(branch.tagName).toBe("SELECT");
    expect(branch).toHaveValue("main");
    expect(branch).toBeDisabled();
    // Cancel then Save in the footer, and the header's close.
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .slice(-2),
    ).toEqual(["Cancel", "Save"]);
    expect(dialog.querySelector("[data-header-close]")).not.toBeNull();
    expect(
      within(dialog).getByTestId("edit-workspace-agents"),
    ).toHaveTextContent("64 registered");
    expect(within(dialog).getByLabelText("Namespace")).toHaveValue(
      workspace.namespace,
    );
    expect(within(dialog).getByLabelText("Governance mode")).toHaveValue("");
    for (const fact of ["Toolbelt limit", "Agents"]) {
      expect(dialog).toHaveTextContent(fact);
    }
    const name = within(dialog).getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Core");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // The governance select was left on "leave unchanged", so the mode travels
    // empty and no governance capability is invoked (see
    // workspace-governance.test.tsx for the modes themselves). The spend
    // controls were left as they opened: the switch travels as stored, and
    // no lane is in the patch (workspace-spend.test.tsx has the rest).
    expect(editWorkspace).toHaveBeenCalledWith(
      "acme",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
      {
        name: "Core",
        slug: "core-platform",
        mode: "",
        applyImmediately: false,
        runEnrichmentEnabled: true,
        dailyBudgetUsd: {},
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
    expect(dialog).toHaveTextContent(
      "Archiving freezes Core platform: runs, frames, records and spend stay readable forever.",
    );
    // No facts: the count is not readable, so the handler has the last word.
    expect(
      within(dialog).getByTestId("archive-workspace-agents"),
    ).toHaveTextContent("not readable without membership");
    const confirm = within(dialog).getByRole("button", { name: "Archive" });
    // The design's `btn danger`: red ink, never gold.
    expect(confirm.className).toContain("text-error-ink");
    expect(confirm.className).not.toContain("bg-button-primary-bg");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .slice(-2),
    ).toEqual(["Cancel", "Archive"]);
    await userEvent.click(confirm);
    expect(archiveWorkspace).toHaveBeenCalledWith(
      "acme",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(router.replace).toHaveBeenCalledWith("/acme?tab=workspaces");
  });

  it("draws the row's Archive as the design's danger button", () => {
    render(
      <IntlProvider>
        <ArchiveWorkspace org="acme" workspace={workspace} />
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: "Archive" }).className).toContain(
      "text-error-ink",
    );
  });

  it("warns about registered agents and disables Archive while any is registered (negative)", async () => {
    render(
      <IntlProvider>
        <ArchiveWorkspace
          org="acme"
          workspace={workspace}
          facts={workspaceFacts({
            repositories: [],
            agents: 65,
            archiveBlockers: { count: 64, more: false },
          })}
        />
      </IntlProvider>,
    );
    const dialog = await open(
      "Archive",
      "archive-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(
      within(dialog).getByTestId("archive-workspace-agents"),
    ).toHaveTextContent(
      "64 agents are registered here. Deregister or move them first.",
    );
    const confirm = within(dialog).getByRole("button", { name: "Archive" });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(archiveWorkspace).not.toHaveBeenCalled();
  });

  it("says the count is a floor when the page of agents did not reach the end", async () => {
    render(
      <IntlProvider>
        <ArchiveWorkspace
          org="acme"
          workspace={workspace}
          facts={workspaceFacts({
            repositories: [],
            agents: 140,
            archiveBlockers: { count: 99, more: true },
          })}
        />
      </IntlProvider>,
    );
    const dialog = await open(
      "Archive",
      "archive-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(
      within(dialog).getByTestId("archive-workspace-agents"),
    ).toHaveTextContent("At least 99 agents are registered here.");
  });

  it("says no agents are here and leaves Archive enabled when none is registered", async () => {
    render(
      <IntlProvider>
        <ArchiveWorkspace
          org="acme"
          workspace={workspace}
          facts={workspaceFacts({
            repositories: [],
            agents: 1,
            archiveBlockers: { count: 0, more: false },
          })}
        />
      </IntlProvider>,
    );
    const dialog = await open(
      "Archive",
      "archive-workspace-wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(
      within(dialog).getByTestId("archive-workspace-agents"),
    ).toHaveTextContent("No agents here.");
    expect(
      within(dialog).getByRole("button", { name: "Archive" }),
    ).toBeEnabled();
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
