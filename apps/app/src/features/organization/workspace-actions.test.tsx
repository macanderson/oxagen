// @vitest-environment jsdom
// The Workspaces section's writes: create a workspace from the form this lane
// adds, rename one, and archive one. Each reloads the page it changed; a
// refusal is named and nothing navigates. Create asks for a name and for the
// steering repo's place and name (#5196), then holds the dialog open to say
// where the new workspace's steering repo stands and to link to its
// Repositories page.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { renderToaster } from "@/test/toaster";

const {
  router,
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
  readSteeringRepoDestinations,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  editWorkspace: vi.fn(),
  readSteeringRepoDestinations: vi.fn(),
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
}));

const NO_PLACES = {
  destinations: [],
  default: null,
  defaultName: null,
  reauthorize: [],
};

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
  readSteeringRepoDestinations
    .mockReset()
    .mockResolvedValue({ ok: true, value: NO_PLACES });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

async function open(name: string, testId: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByTestId(testId);
}

/** Opens Create a workspace, types the name, and presses Create. */
async function create(name = "Research") {
  render(
    <IntlProvider>
      <CreateWorkspace org="acme" />
    </IntlProvider>,
  );
  const dialog = await open("Create a workspace", "create-workspace");
  await userEvent.type(within(dialog).getByLabelText("Name"), name);
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  return dialog;
}

describe("CreateWorkspace", () => {
  it("asks for the name and the steering repo's name, and offers no code repository", async () => {
    render(
      <IntlProvider>
        <CreateWorkspace org="acme" primary />
      </IntlProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Create a workspace" }),
    ).toHaveClass("bg-button-primary-bg");
    const dialog = await open("Create a workspace", "create-workspace");
    expect(within(dialog).getByLabelText("Name")).toBeRequired();
    // The places load when the dialog opens. With nothing connected there is
    // no Organization select.
    expect(readSteeringRepoDestinations).toHaveBeenCalledWith("acme");
    await within(dialog).findByTestId("create-workspace-steering-connection-none");
    // Oxagen makes the steering repo, so the form offers no code repository,
    // and the action makes the slug from the name.
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(2);
    expect(within(dialog).getByLabelText("Repository name")).not.toBeRequired();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    for (const gone of [
      "Main repository",
      "Production branch",
      "Governance mode",
      "Retention mode",
      "Namespace",
      "Slug",
    ]) {
      expect(within(dialog).queryByLabelText(gone)).toBeNull();
    }
  });

  // WL-62: the write answers with the new workspace's slug, and closing the
  // panel lands the operator in it.
  it("sends the name and the repository name, holds the dialog open on the result, and opens the new workspace's Fleet on Done", async () => {
    // The root layout's toaster, where the receipt lands (ADR-221).
    renderToaster();
    createWorkspace.mockResolvedValue({
      ok: true,
      value: { slug: "research", name: "Research", steeringRepo: "provisioning" },
    });
    const dialog = await create();
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research",
      steeringRepo: { name: "oxagen-research" },
    });
    const done = await within(dialog).findByTestId("create-workspace-done");
    expect(within(done).getByTestId("create-workspace-done-name")).toHaveTextContent(
      "Research",
    );
    expect(done).toHaveTextContent("Steering repo");
    expect(
      within(done).getByRole("link", { name: "Open repositories" }),
    ).toHaveAttribute("href", "/acme/research/repositories");
    // The form gave way to the result: no Create is left to press twice.
    expect(within(dialog).queryByRole("button", { name: "Create" })).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    // The write leaves its receipt in the app's toast region.
    await waitFor(() => {
      expect(screen.getByTestId("toasts")).toHaveTextContent(
        "The workspace was created. Recorded in the audit record.",
      );
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(router.replace).toHaveBeenCalledWith("/acme/research");
  });

  it.each([
    ["provisioning", "Oxagen is creating the private repository now."],
    [
      "ready",
      "The private repository is created and bound to this workspace.",
    ],
    ["failed", "A step stopped before the repository was ready."],
    [
      "blocked",
      "An organization owner has to act first, such as authorizing Oxagen again.",
    ],
  ])(
    "reads a steering repo that is %s in one sentence, with the Repositories link",
    async (status, sentence) => {
      createWorkspace.mockResolvedValue({
        ok: true,
        value: { slug: "research", name: "Research", steeringRepo: status },
      });
      const dialog = await create();
      const done = await within(dialog).findByTestId("create-workspace-done");
      expect(
        within(done).getByTestId("create-workspace-steering-status"),
      ).toHaveTextContent(sentence);
      expect(
        within(done).getByTestId("create-workspace-open-repositories"),
      ).toHaveAttribute("href", "/acme/research/repositories");
    },
  );

  // A name that makes no valid slug is refused as invalid, and the generic
  // sentence is the one shown.
  it("keeps the generic invalid sentence for a name that makes no slug (negative)", async () => {
    createWorkspace.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "name",
    });
    await create();
    expect(
      await screen.findByTestId("create-workspace-failure"),
    ).toHaveTextContent("The request was refused as invalid.");
    expect(screen.queryByTestId("create-workspace-done")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names an address already taken, as the name's, and creates nothing (negative)", async () => {
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
    createWorkspace.mockResolvedValue({
      ok: true,
      value: { slug: "research", name: "Research", steeringRepo: "provisioning" },
    });
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
    const name = within(dialog).getByLabelText("Name");
    const repo = within(dialog).getByLabelText("Repository name");
    await userEvent.type(name, "Research");
    expect(repo).toHaveValue("oxagen-research");
    await userEvent.clear(repo);
    await userEvent.type(repo, "research-steering");
    await userEvent.type(name, " lab");
    expect(repo).toHaveValue("research-steering");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research lab",
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
    createWorkspace.mockResolvedValue({
      ok: true,
      value: { slug: "research", name: "Research", steeringRepo: "provisioning" },
    });
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
    await userEvent.type(within(dialog).getByLabelText("Name"), "Research");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createWorkspace).toHaveBeenCalledWith("acme", {
      name: "Research",
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
    await userEvent.type(within(dialog).getByLabelText("Name"), "Research");
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
          facts={{
            repositories: [
              { role: "main", fullName: "acme/platform", defaultRef: "main" },
            ],
            agents: 64,
            archiveBlockers: { count: 63, more: false },
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
          facts={{
            repositories: [],
            agents: 65,
            archiveBlockers: { count: 64, more: false },
          }}
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
          facts={{
            repositories: [],
            agents: 140,
            archiveBlockers: { count: 99, more: true },
          }}
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
          facts={{
            repositories: [],
            agents: 1,
            archiveBlockers: { count: 0, more: false },
          }}
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
