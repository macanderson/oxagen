// @vitest-environment jsdom
// The add and edit dialog for one identity provider.
//
// The cases the design turns on:
//   - the fields follow the protocol (a client secret for OIDC, a signing
//     certificate for SAML);
//   - a refusal the action names on a field is shown under that field, and
//     the dialog stays open;
//   - editing shows that a secret is stored without showing it, and a blank
//     secret field is sent blank so the stored one stays;
//   - the domain and the provider ID cannot change on an edit.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, createSsoProvider, updateSsoProvider } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  createSsoProvider: vi.fn(),
  updateSsoProvider: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./sso-actions", () => ({ createSsoProvider, updateSsoProvider }));

const { SsoProviderDialog } = await import("./sso-provider-form");
const { samlProvider, ssoProvider } = await import("./organization.builders");

beforeEach(() => {
  for (const fn of [createSsoProvider, updateSsoProvider, router.refresh])
    fn.mockReset();
});
afterEach(cleanup);

async function openAdd() {
  render(
    <IntlProvider>
      <SsoProviderDialog org="acme" />
    </IntlProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
  return screen.findByTestId("sso-add");
}

describe("SsoProviderDialog: adding", () => {
  it("asks an OIDC provider for an issuer, a client ID and a client secret", async () => {
    const dialog = await openAdd();
    expect(within(dialog).getByLabelText("Issuer URL")).toBeTruthy();
    expect(within(dialog).getByLabelText("Client ID")).toBeTruthy();
    expect(within(dialog).getByLabelText("Client secret")).toHaveAttribute(
      "type",
      "password",
    );
    expect(within(dialog).queryByLabelText("Signing certificate")).toBeNull();
    expect(within(dialog).getByLabelText("Groups claim")).toHaveValue("groups");
    await expectNoAxe(dialog);
  });

  it("asks a SAML provider for its entity ID, SSO URL and certificate", async () => {
    const dialog = await openAdd();
    await userEvent.click(within(dialog).getByLabelText("SAML"));
    expect(within(dialog).getByLabelText("IdP entity ID")).toBeTruthy();
    expect(within(dialog).getByLabelText("SSO URL")).toBeTruthy();
    expect(within(dialog).getByLabelText("Signing certificate")).toBeTruthy();
    expect(within(dialog).getByLabelText("SP private key")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Client secret")).toBeNull();
  });

  it("sends the draft, closes and re-reads the page", async () => {
    createSsoProvider.mockResolvedValue({
      ok: true,
      value: { providerId: "acme-okta" },
    });
    const dialog = await openAdd();
    await userEvent.type(
      within(dialog).getByLabelText("Provider ID"),
      "acme-okta",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Display name"),
      "Acme Okta",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Email domain"),
      "acme.com",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Issuer URL"),
      "https://acme.okta.com",
    );
    await userEvent.type(within(dialog).getByLabelText("Client ID"), "0oa1");
    await userEvent.type(within(dialog).getByLabelText("Client secret"), "s3");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save provider" }),
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(createSsoProvider).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({
        protocol: "oidc",
        providerId: "acme-okta",
        displayName: "Acme Okta",
        domain: "acme.com",
        groupsClaim: "groups",
        issuer: "https://acme.okta.com",
        clientId: "0oa1",
        clientSecret: "s3",
      }),
    );
    expect(screen.queryByTestId("sso-add")).toBeNull();
  });

  it("names a refused field under that field and stays open (negative)", async () => {
    createSsoProvider.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "domain_required",
      field: "domain",
    });
    const dialog = await openAdd();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save provider" }),
    );
    const domain = await within(dialog).findByLabelText("Email domain");
    await waitFor(() => {
      expect(domain).toHaveAttribute("aria-invalid", "true");
    });
    expect(within(dialog).getByText("Enter an email domain.")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names a taken domain once for the whole form (negative)", async () => {
    createSsoProvider.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "domain_taken",
    });
    const dialog = await openAdd();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save provider" }),
    );
    expect(
      await within(dialog).findByTestId("sso-add-failure"),
    ).toHaveTextContent("Another provider already uses this email domain.");
  });
});

describe("SsoProviderDialog: editing", () => {
  it("says the client secret is stored, never shows it, and sends it blank", async () => {
    updateSsoProvider.mockResolvedValue({
      ok: true,
      value: { providerId: "acme-okta" },
    });
    render(
      <IntlProvider>
        <SsoProviderDialog org="acme" provider={ssoProvider()} />
      </IntlProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByTestId("sso-edit-acme-okta");
    expect(within(dialog).getByLabelText("Client secret")).toHaveValue("");
    expect(dialog).toHaveTextContent("Stored. Leave blank to keep it.");
    expect(within(dialog).getByLabelText("Provider ID")).toHaveAttribute(
      "readonly",
    );
    expect(within(dialog).getByLabelText("Email domain")).toHaveAttribute(
      "readonly",
    );
    expect(within(dialog).queryByLabelText("SAML")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save provider" }),
    );
    await waitFor(() => {
      expect(updateSsoProvider).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({
          providerId: "acme-okta",
          clientSecret: "",
          clientId: "0oa1b2c3d4",
        }),
      );
    });
  });

  it("hands the action the stored SAML settings, so a change without a certificate can be named", async () => {
    updateSsoProvider.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "cert_required_for_change",
      field: "cert",
    });
    render(
      <IntlProvider>
        <SsoProviderDialog org="acme" provider={samlProvider()} />
      </IntlProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByTestId("sso-edit-acme-entra");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save provider" }),
    );
    expect(
      await within(dialog).findByText(
        "Paste the signing certificate to save a change to the SAML settings.",
      ),
    ).toBeTruthy();
    expect(updateSsoProvider).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({
        stored: {
          issuer: "https://sts.windows.net/acme/",
          clientId: "",
          entryPoint: "https://login.microsoftonline.com/acme/saml2",
        },
      }),
    );
  });
});
