// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { IntlProvider } from "../../auth/test-intl";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const createOrganizationAction = vi.fn();
vi.mock("../actions", () => ({ createOrganizationAction }));

const { OrganizationForm } = await import("./organization-form");

function renderWithIntl(ui: ReactNode) {
  return render(<IntlProvider>{ui}</IntlProvider>);
}

beforeEach(() => {
  router.push.mockReset();
  createOrganizationAction.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("OrganizationForm", () => {
  it("derives each address from its name until the address is edited", async () => {
    renderWithIntl(<OrganizationForm />);
    await userEvent.type(
      screen.getByLabelText("Organization name"),
      "Acme Robotics",
    );
    expect(screen.getByLabelText("Address")).toHaveValue("acme-robotics");
    await userEvent.clear(screen.getByLabelText("Address"));
    await userEvent.type(screen.getByLabelText("Address"), "acr");
    await userEvent.type(screen.getByLabelText("Organization name"), "!");
    expect(screen.getByLabelText("Address")).toHaveValue("acr");
    await userEvent.type(
      screen.getByLabelText("Workspace name"),
      "Core Platform",
    );
    expect(screen.getByLabelText("Workspace address")).toHaveValue(
      "core-platform",
    );
  });

  it("validates before calling the action", async () => {
    renderWithIntl(<OrganizationForm />);
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    expect(
      screen.getByText("Enter the organization's name."),
    ).toBeInTheDocument();
    expect(createOrganizationAction).not.toHaveBeenCalled();
  });

  it("lands on the new organization's Fleet page, or shows what the server refused: a field, a taken address, a denial, a failure", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "slug_taken",
    });
    renderWithIntl(<OrganizationForm initialName="Acme Robotics" />);
    await userEvent.type(
      screen.getByLabelText("Workspace name"),
      "core-platform",
    );
    const submit = () =>
      userEvent.click(
        screen.getByRole("button", { name: "Create organization" }),
      );
    await submit();
    expect(
      await screen.findByText(
        "That address belongs to another organization. Pick a different one.",
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
      reason: "denied",
      code: "authz_denied",
    });
    await submit();
    expect(await screen.findByTestId("organization-denied")).toHaveTextContent(
      "This account may not create an organization.",
    );

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

    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      value: { to: "/acme-robotics/core-platform" },
    });
    await submit();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/acme-robotics/core-platform");
    });
  });

  it("continues to the requested destination instead of the Fleet page", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      value: { to: "/acme-robotics/core-platform" },
    });
    renderWithIntl(
      <OrganizationForm
        initialName="Acme Robotics"
        destination={routes.cliAuthorize({ state: "abc" })}
      />,
    );
    await userEvent.type(
      screen.getByLabelText("Workspace name"),
      "core-platform",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/cli/authorize?state=abc");
    });
  });
});
