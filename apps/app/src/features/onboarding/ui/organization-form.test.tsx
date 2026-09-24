// @vitest-environment jsdom
// Onboarding step 1 as an operator drives it: the fields in the design's order
// with its copy, the derived address and suggested namespace, the governance
// mode's not-recorded note, and every answer the server can give: a taken
// namespace (the error state), a refused field, a denial (the denied state), a
// failure, and the continue to Wrap an agent or to a requested destination.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const createOrganizationAction = vi.fn();
vi.mock("../actions", () => ({ createOrganizationAction }));

const { OrganizationForm } = await import("./organization-form");

const WRAP = "/welcome/aintel/core-platform/wrap";

function renderForm(
  props: { destination?: ReturnType<typeof routes.root> } = {},
) {
  render(
    <IntlProvider>
      <OrganizationForm
        initialName="Anderson Intelligence Corp."
        cancel={routes.root()}
        email="marcus@a-intel.example"
        host="oxagen.com"
        {...props}
      />
    </IntlProvider>,
  );
}

const submit = () =>
  userEvent.click(screen.getByRole("button", { name: "Continue" }));

beforeEach(() => {
  router.push.mockReset();
  createOrganizationAction.mockReset();
});
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("OrganizationForm", () => {
  it("draws the header, the fields in the design's order and the footer", () => {
    renderForm();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Name your organization" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The organization is the tenant: it owns its own graph/),
    ).toBeInTheDocument();
    const ids = [...document.querySelectorAll("input, select")].map(
      (el) => el.id,
    );
    expect(ids).toEqual(["ob-org", "ob-url", "ob-ns", "ob-ws", "ob-mode"]);
    expect(screen.getByLabelText("Address")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Address")).toHaveValue(
      "oxagen.com/anderson-intelligence-corp",
    );
    expect(
      screen.getByText("Derived from the name. You can change it later."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Namespace")).toHaveAttribute(
      "maxlength",
      "6",
    );
    expect(screen.getByLabelText("Namespace")).toHaveValue("anders");
    expect(document.getElementById("ob-ns-hint")).toHaveTextContent(
      "2–6 characters, immutable. Every agent key starts with it: anders.<workspace>.<agent>",
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "First workspace" }),
    ).toBeInTheDocument();
    const mode = screen.getByLabelText("Governance mode");
    expect(
      within(mode)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["solo", "team", "regulated"]);
    expect(mode).toHaveValue("team");
    expect(screen.getByTestId("governance-not-backed")).toHaveTextContent(
      "The governance mode is not recorded yet.",
    );
    expect(
      screen.getByText(
        "A workspace is a governance partition: one main repo, one steering set, its own agents, tool grants and budgets.",
      ),
    ).toBeInTheDocument();
    const footer = screen.getByTestId("gate-footer");
    expect(
      [...footer.querySelectorAll("a, button")].map((el) => el.textContent),
    ).toEqual(["Cancel", "Continue"]);
    expect(
      within(footer).getByRole("link", { name: "Cancel" }),
    ).toHaveAttribute("href", "/");
    expect(footer).toHaveTextContent(
      "Creates org_anders and its graph database.",
    );
  });

  it("derives the address from the name, and the namespace until it is edited", async () => {
    renderForm();
    const name = screen.getByLabelText("Organization name");
    await userEvent.clear(name);
    await userEvent.type(name, "Acme Robotics");
    expect(screen.getByLabelText("Address")).toHaveValue(
      "oxagen.com/acme-robotics",
    );
    expect(screen.getByLabelText("Namespace")).toHaveValue("acmero");
    await userEvent.clear(screen.getByLabelText("Namespace"));
    await userEvent.type(screen.getByLabelText("Namespace"), "acme");
    await userEvent.type(name, " Inc");
    expect(screen.getByLabelText("Namespace")).toHaveValue("acme");
    await userEvent.selectOptions(
      screen.getByLabelText("Governance mode"),
      "regulated",
    );
    expect(screen.getByLabelText("Governance mode")).toHaveValue("regulated");
  });

  it("validates before calling the action (negative)", async () => {
    renderForm();
    await userEvent.clear(screen.getByLabelText("Namespace"));
    await userEvent.type(screen.getByLabelText("Namespace"), "a");
    await submit();
    expect(
      screen.getByText("Use 2–6 lowercase letters or digits."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Enter a name for the first workspace."),
    ).toBeInTheDocument();
    expect(createOrganizationAction).not.toHaveBeenCalled();
  });

  it("sends the derived addresses and the chosen namespace, then continues to Wrap an agent", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      value: { to: WRAP },
    });
    renderForm();
    await userEvent.type(
      screen.getByLabelText("Workspace name"),
      "Core Platform",
    );
    await submit();
    expect(createOrganizationAction).toHaveBeenCalledWith({
      name: "Anderson Intelligence Corp.",
      slug: "anderson-intelligence-corp",
      namespace: "anders",
      workspaceName: "Core Platform",
      workspaceSlug: "core-platform",
    });
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(WRAP);
    });
  });

  it("shows a taken namespace above the fields and marks the Namespace input bad (the error state)", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "namespace_taken",
    });
    renderForm();
    await userEvent.type(screen.getByLabelText("Workspace name"), "core");
    await submit();
    const alert = await screen.findByTestId("organization-namespace-taken");
    expect(alert).toHaveTextContent(
      "That namespace is taken. anders belongs to another organization. Pick a different 2–6 character namespace.",
    );
    expect(screen.getByLabelText("Namespace")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Organization name")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("names a refused field, a taken address and a failure (negative)", async () => {
    renderForm();
    await userEvent.type(screen.getByLabelText("Workspace name"), "core");
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "slug_taken",
    });
    await submit();
    expect(
      await screen.findByText(
        "That address belongs to another organization. Change the organization name to change the address.",
      ),
    ).toBeInTheDocument();
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      code: "workspaceSlugReserved",
      field: "workspaceSlug",
    });
    await submit();
    expect(
      await screen.findByText(
        "That address is used by an organization page. Pick another.",
      ),
    ).toBeInTheDocument();
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "kernel_failure",
    });
    await submit();
    expect(
      await screen.findByTestId("organization-failed"),
    ).toBeInTheDocument();
    createOrganizationAction.mockRejectedValueOnce(new Error("offline"));
    await submit();
    expect(
      await screen.findByTestId("organization-failed"),
    ).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("replaces the card with the denied state when the server refuses the person (the denied state)", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    renderForm();
    await userEvent.type(screen.getByLabelText("Workspace name"), "core");
    await submit();
    const denied = await screen.findByTestId("page-state-denied");
    expect(
      within(denied).getByRole("heading", {
        name: "You cannot see onboarding",
      }),
    ).toBeInTheDocument();
    expect(denied).toHaveTextContent("org.create for marcus@a-intel.example");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("continues to the requested destination instead of Wrap an agent", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      value: { to: WRAP },
    });
    renderForm({ destination: routes.cliAuthorize({ state: "abc" }) });
    await userEvent.type(screen.getByLabelText("Workspace name"), "core");
    await submit();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/cli/authorize?state=abc");
    });
  });
});
