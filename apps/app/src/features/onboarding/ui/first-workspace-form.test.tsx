// @vitest-environment jsdom
// The first workspace's name form as an operator drives it: the name, the
// steering repo's Organization and Repository name (#5196), the re-read once
// `create_workspace` answers, and every refusal the action can give: the name
// errors under the field, a denial and a failure above the form. Axe runs
// after every test.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const createFirstWorkspace =
  vi.fn<typeof import("../actions").createFirstWorkspace>();
const readFirstWorkspaceDestinations =
  vi.fn<typeof import("../actions").readFirstWorkspaceDestinations>();
vi.mock("../actions", () => ({
  createFirstWorkspace,
  readFirstWorkspaceDestinations,
}));

const NO_PLACES = {
  destinations: [],
  default: null,
  defaultName: null,
  reauthorize: [],
};
const PLACES = {
  destinations: [
    { provider: "github" as const, id: 12, name: "acme", kind: "organization" as const },
    { provider: "github" as const, id: 22, name: "acme-labs", kind: "organization" as const },
  ],
  default: {
    provider: "github" as const,
    id: 22,
    name: "acme-labs",
    kind: "organization" as const,
  },
  defaultName: null,
  reauthorize: [],
};

const { FirstWorkspaceForm } = await import("./first-workspace-form");

function renderForm() {
  render(
    <IntlProvider>
      <FirstWorkspaceForm org="acme" />
    </IntlProvider>,
  );
}

async function create(name = "Core platform") {
  await userEvent.type(screen.getByLabelText("Workspace name"), name);
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
}

beforeEach(() => {
  router.refresh.mockReset();
  createFirstWorkspace.mockReset();
  readFirstWorkspaceDestinations
    .mockReset()
    .mockResolvedValue({ ok: true, value: NO_PLACES });
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("FirstWorkspaceForm", () => {
  it("asks for the name and the repository name, creates the workspace, and re-reads the page", async () => {
    createFirstWorkspace.mockResolvedValueOnce({
      ok: true,
      value: { slug: "core-platform" },
    });
    renderForm();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    // With nothing connected yet there is no Organization select, and the
    // form sends no place, so the job takes the organization's default.
    expect(
      await screen.findByTestId("ob-workspace-steering-connection-none"),
    ).toHaveTextContent(
      "Oxagen creates the repository in the GitHub organization or GitLab group you connect.",
    );
    expect(screen.queryByLabelText("Organization")).toBeNull();
    await create();
    expect(createFirstWorkspace).toHaveBeenCalledWith(
      "acme",
      "Core platform",
      { name: "oxagen-core-platform" },
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("first-workspace-refused")).toBeNull();
    expect(screen.getByLabelText("Workspace name")).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it.each([
    [
      { reason: "invalid" as const, code: "name_required" },
      "Enter a name for the workspace.",
    ],
    [
      { reason: "invalid" as const, code: "name_too_long" },
      "Use at most 120 characters.",
    ],
    [
      { reason: "invalid" as const, code: "invalid_input", field: "name" },
      "Oxagen cannot make an address from that name. Use at least two letters or digits.",
    ],
    [
      { reason: "conflict" as const, code: "slug_taken" },
      "A workspace in this organization already uses that address. Choose another name.",
    ],
  ])(
    "shows the refused name %o under the field (negative)",
    async (refused, sentence) => {
      createFirstWorkspace.mockResolvedValueOnce({ ok: false, ...refused });
      renderForm();
      await create();
      const field = screen.getByLabelText("Workspace name");
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription(sentence);
      expect(router.refresh).not.toHaveBeenCalled();
      expect(screen.queryByTestId("first-workspace-refused")).toBeNull();
    },
  );

  it("follows the workspace name with the repository name until the person edits it", async () => {
    renderForm();
    const workspace = screen.getByLabelText("Workspace name");
    const repo = screen.getByLabelText("Repository name");
    expect(repo).toHaveValue("");
    await userEvent.type(workspace, "Core");
    expect(repo).toHaveValue("oxagen-core");
    await userEvent.type(workspace, " platform");
    expect(repo).toHaveValue("oxagen-core-platform");
    await userEvent.clear(repo);
    await userEvent.type(repo, "steering-core");
    await userEvent.type(workspace, " EU");
    expect(repo).toHaveValue("steering-core");
  });

  it("starts the Organization select on the default and sends the pick with the name", async () => {
    readFirstWorkspaceDestinations.mockResolvedValue({
      ok: true,
      value: PLACES,
    });
    createFirstWorkspace.mockResolvedValueOnce({
      ok: true,
      value: { slug: "core-platform" },
    });
    renderForm();
    expect(readFirstWorkspaceDestinations).toHaveBeenCalledWith("acme");
    const select = await screen.findByTestId("ob-workspace-steering-connection");
    expect(select).toHaveAccessibleName("Organization");
    expect(select).toHaveValue("github:22");
    await userEvent.selectOptions(select, "github:12");
    await create();
    expect(createFirstWorkspace).toHaveBeenCalledWith("acme", "Core platform", {
      name: "oxagen-core-platform",
      connection: { provider: "github", id: 12 },
    });
  });

  it("marks a personal account, and names the host when GitHub and GitLab both appear", async () => {
    readFirstWorkspaceDestinations.mockResolvedValue({
      ok: true,
      value: {
        destinations: [
          { provider: "github", id: 13, name: "mac", kind: "user" },
          { provider: "gitlab", id: 42, name: "acme/platform", kind: "organization" },
        ],
        default: null,
        defaultName: null,
        reauthorize: ["github"],
      },
    });
    renderForm();
    const select = await screen.findByTestId("ob-workspace-steering-connection");
    expect(
      [...select.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["mac (GitHub personal account)", "acme/platform (GitLab)"]);
    // No default is stored, so the first place starts picked.
    expect(select).toHaveValue("github:13");
    expect(screen.getByTestId("ob-workspace-steering-repo")).toHaveTextContent(
      "GitHub refused Oxagen's stored authorization",
    );
  });

  it("still creates the workspace when the places do not load, and sends no place (negative)", async () => {
    readFirstWorkspaceDestinations.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "github_unreachable",
    });
    createFirstWorkspace.mockResolvedValueOnce({
      ok: true,
      value: { slug: "core-platform" },
    });
    renderForm();
    expect(
      await screen.findByTestId("ob-workspace-steering-connection-failed"),
    ).toHaveTextContent(
      "The organizations did not load (github_unreachable). Oxagen uses the organization's default.",
    );
    await create();
    expect(createFirstWorkspace).toHaveBeenCalledWith("acme", "Core platform", {
      name: "oxagen-core-platform",
    });
  });

  it("refuses a repository name the contract would refuse before it sends anything (negative)", async () => {
    renderForm();
    await userEvent.type(screen.getByLabelText("Workspace name"), "Core platform");
    const repo = screen.getByLabelText("Repository name");
    await userEvent.clear(repo);
    await userEvent.type(repo, "oxagen-config");
    expect(repo).toHaveAttribute("aria-invalid", "true");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createFirstWorkspace).not.toHaveBeenCalled();
  });

  it("puts the server's refusal of the repository name under that field (negative)", async () => {
    createFirstWorkspace.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "steeringRepo.name",
    });
    renderForm();
    await create();
    const repo = screen.getByLabelText("Repository name");
    expect(repo).toHaveAttribute("aria-invalid", "true");
    expect(repo).toHaveAccessibleDescription(/Use up to 100 letters/);
    expect(screen.getByLabelText("Workspace name")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(screen.queryByTestId("first-workspace-refused")).toBeNull();
  });

  it("says the role cannot create a workspace when the kernel denies it (negative)", async () => {
    createFirstWorkspace.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderForm();
    await create();
    expect(screen.getByTestId("first-workspace-refused")).toHaveTextContent(
      "Your role on this organization cannot create a workspace. An owner or admin can.",
    );
    expect(screen.getByLabelText("Workspace name")).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("names the code of a failed write, a pending approval, or a thrown action (negative)", async () => {
    createFirstWorkspace.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "workspace_store_unavailable",
    });
    renderForm();
    await create();
    expect(screen.getByTestId("first-workspace-refused")).toHaveTextContent(
      "The workspace was not created (workspace_store_unavailable). Try again.",
    );
    cleanup();

    createFirstWorkspace.mockResolvedValueOnce({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_01",
    });
    renderForm();
    await create();
    expect(screen.getByTestId("first-workspace-refused")).toHaveTextContent(
      "The workspace was not created (pending_approval). Try again.",
    );
    cleanup();

    createFirstWorkspace.mockRejectedValueOnce(new Error("socket hang up"));
    renderForm();
    await create();
    expect(screen.getByTestId("first-workspace-refused")).toHaveTextContent(
      "The workspace was not created (action_failed). Try again.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
