// @vitest-environment jsdom
// Onboarding step 1 as an operator drives it: the fields in the design's order
// with its copy, the derived address and suggested namespace, no workspace
// field (the first workspace is step 3, after Connect), and every answer the
// server can give: a taken namespace (the error state), a refused field, a
// denial (the denied state), a failure, and the continue to Connect a code host
// or to a requested destination.
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

const CONNECT = "/welcome/aintel/new-workspace/connect";

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
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Name your organization" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The organization is the tenant: it owns its own graph/),
    ).toBeInTheDocument();
    const ids = [...document.querySelectorAll("input, select")].map(
      (el) => el.id,
    );
    expect(ids).toEqual(["ob-org", "ob-url", "ob-ns"]);
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
      "It takes 2 to 6 characters and is immutable. Every agent key starts with it: anders.<workspace>.<agent>.",
    );
    // The first workspace is named after Connect, so the form has no
    // workspace section and no governance mode.
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
    expect(screen.queryByLabelText("Governance mode")).toBeNull();
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
  });

  it("validates before calling the action (negative)", async () => {
    renderForm();
    await userEvent.clear(screen.getByLabelText("Namespace"));
    await userEvent.type(screen.getByLabelText("Namespace"), "a");
    await submit();
    expect(
      screen.getByText("Use 2–6 lowercase letters or digits."),
    ).toBeInTheDocument();
    expect(createOrganizationAction).not.toHaveBeenCalled();
  });

  it("sends the derived address and the chosen namespace, with no workspace or destination, then continues to Connect", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      value: { to: CONNECT },
    });
    renderForm();
    await submit();
    expect(createOrganizationAction).toHaveBeenCalledWith(
      {
        name: "Anderson Intelligence Corp.",
        slug: "anderson-intelligence-corp",
        namespace: "anders",
      },
      undefined,
    );
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(CONNECT);
    });
  });

  it("shows a taken namespace above the fields and marks the Namespace input bad (the error state)", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "namespace_taken",
    });
    renderForm();
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
      code: "slugReserved",
      field: "slug",
    });
    await submit();
    expect(
      await screen.findByText(
        "That address is used by an Oxagen page. Pick another.",
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

  it("sends the requested destination and continues where the server answers", async () => {
    // The server gives the organization a workspace and answers with the
    // destination, because the CLI consent page lists only organizations that
    // have one.
    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      value: { to: "/cli/authorize?state=abc" },
    });
    renderForm({ destination: routes.cliAuthorize({ state: "abc" }) });
    await submit();
    expect(createOrganizationAction).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "anderson-intelligence-corp" }),
      "/cli/authorize?state=abc",
    );
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/cli/authorize?state=abc");
    });
  });
});
