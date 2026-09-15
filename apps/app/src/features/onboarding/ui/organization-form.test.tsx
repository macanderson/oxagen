// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { IntlProvider } from "@/test/intl";

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
  it("derives the address and namespace from the name until they are edited", async () => {
    renderWithIntl(<OrganizationForm />);
    await userEvent.type(
      screen.getByLabelText("Organization name"),
      "Acme Robotics",
    );
    expect(screen.getByLabelText("Address")).toHaveValue("acme-robotics");
    expect(screen.getByLabelText("Namespace")).toHaveValue("acme");
    await userEvent.clear(screen.getByLabelText("Namespace"));
    await userEvent.type(screen.getByLabelText("Namespace"), "acr");
    await userEvent.type(screen.getByLabelText("Organization name"), "!");
    expect(screen.getByLabelText("Namespace")).toHaveValue("acr");
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

  it("lands on the new organization's Fleet page, or shows what the server refused", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      fields: { slug: "slugTaken" },
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
      error: "failed",
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
      to: "/acme-robotics/core-platform",
    });
    await submit();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/acme-robotics/core-platform");
    });
  });

  it("continues to the requested destination instead of the Fleet page", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      to: "/acme-robotics/core-platform",
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
