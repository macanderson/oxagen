// @vitest-environment jsdom
// The first workspace's name form as an operator drives it: the one field,
// the re-read once `create_workspace` answers, and every refusal the action
// can give: the name errors under the field, a denial and a failure above the
// form. Axe runs after every test.
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
vi.mock("../actions", () => ({ createFirstWorkspace }));

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
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("FirstWorkspaceForm", () => {
  it("asks for the name alone, creates the workspace, and re-reads the page", async () => {
    createFirstWorkspace.mockResolvedValueOnce({
      ok: true,
      value: { slug: "core-platform" },
    });
    renderForm();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    await create();
    expect(createFirstWorkspace).toHaveBeenCalledWith("acme", "Core platform");
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
