// @vitest-environment jsdom
// Organization › Single sign-on over org.sso: what the page shows for each
// answer the `list_sso_providers` read can give, and what its controls send.
//
// The cases the design turns on:
//   - no provider: the empty state says what a provider is for;
//   - a verified and a pending provider: each row says which, and each
//     provider shows the DNS record and the URLs the admin pastes elsewhere;
//   - Require SSO is off and unusable until a domain is verified, and the page
//     says Owners keep password sign-in either way;
//   - on a plan without SSO the page says so and links to Billing, keeps
//     Delete, and offers Require SSO only to turn it off;
//   - a viewer below Owner or Admin sees no control, and a refused read says
//     so in place of the page's sections, with the tabs kept;
//   - the forms' lists mirror the contract, so no role or protocol the
//     contract refuses can be offered.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoSettings } from "@/data/contracts/org";
import { type Read, readError } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

/** Narrow a queried node to an element, failing the test when it is absent. */
function asElement(node: Element | null | undefined): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error("element missing");
  return node;
}

const { router, actions } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  actions: {
    createSsoProvider: vi.fn(),
    updateSsoProvider: vi.fn(),
    deleteSsoProvider: vi.fn(),
    verifySsoDomain: vi.fn(),
    setSsoRequired: vi.fn(),
    setSsoGroupRoles: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/acme/sso",
}));
vi.mock("./sso-actions", () => actions);
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { orgSource, samlProvider, ssoProvider, ssoSettings } = await import(
  "./organization.builders"
);
const { Sso } = await import("./sso");
const { SSO_PROTOCOLS, SSO_ROLES } = await import("./sso-rules");

// The section is rendered the way the page renders it: the async server
// component asks the data source for the one read it needs. Rendering it
// this way also proves the read is the org-scoped `sso` and nothing else.
async function renderSection(
  read: Read<SsoSettings>,
  orgRole: OrgRole = "owner",
) {
  const ctx = unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
  });
  const { source, calls } = orgSource({ sso: read });
  const view = render(
    <IntlProvider>{await Sso({ ctx, source })}</IntlProvider>,
  );
  expect(calls.sso).toEqual([[ctx]]);
  return view;
}

const BOTH = ssoSettings({ providers: [ssoProvider(), samlProvider()] });

beforeEach(() => {
  for (const fn of [...Object.values(actions), router.refresh]) fn.mockReset();
});
afterEach(cleanup);

describe("Sso: no provider", () => {
  it("explains what a provider is for and offers to add one", async () => {
    const { container } = await renderSection({
      ok: true,
      value: ssoSettings({ providers: [] }),
    });
    expect(screen.getByTestId("sso-empty")).toHaveTextContent(
      "lets members sign in with your company identity provider",
    );
    expect(screen.getByRole("button", { name: "Add provider" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await expectNoAxe(container);
  });

  it("keeps Require SSO off and says why", async () => {
    await renderSection({ ok: true, value: ssoSettings({ providers: [] }) });
    const toggle = screen.getByRole("switch", {
      name: "Require SSO for members",
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText("Verify a provider's domain before you require SSO."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Owners can always sign in with a password/),
    ).toBeTruthy();
  });
});

describe("Sso: a verified and a pending provider", () => {
  it("lists each with its protocol, domain and domain status", async () => {
    const { container } = await renderSection({ ok: true, value: BOTH });
    const table = screen.getByRole("table", { name: "Identity providers" });
    const [okta, entra] = within(table).getAllByRole("row").slice(1);
    expect(okta).toHaveTextContent("Acme Okta");
    expect(okta).toHaveTextContent("OIDC");
    expect(okta).toHaveTextContent("acme.com");
    expect(okta?.querySelector("[data-domain-status]")).toHaveAttribute(
      "data-domain-status",
      "verified",
    );
    expect(entra).toHaveTextContent("SAML");
    expect(entra?.querySelector("[data-domain-status]")).toHaveTextContent(
      "Pending",
    );
    expect(
      within(asElement(okta)).getByRole("button", { name: "Edit" }),
    ).toBeTruthy();
    await expectNoAxe(container);
  });

  it("shows the DNS record and the URLs the identity provider needs", async () => {
    await renderSection({ ok: true, value: BOTH });
    expect(
      screen.getByTestId("sso-setup-acme-entra-record-name"),
    ).toHaveTextContent("_oxagen-sso.acme.io");
    expect(
      screen.getByTestId("sso-setup-acme-entra-record-value"),
    ).toHaveTextContent("oxagen-sso-verification=8b1e5f30");
    const entra = screen.getByTestId("sso-setup-acme-entra");
    expect(entra).toHaveTextContent("ACS URL");
    expect(entra).toHaveTextContent("SP metadata URL");
    const okta = screen.getByTestId("sso-setup-acme-okta");
    expect(okta).toHaveTextContent("Redirect URI");
    expect(okta).not.toHaveTextContent("SP metadata URL");
  });

  it("offers Verify domain only for the pending provider", async () => {
    await renderSection({ ok: true, value: BOTH });
    expect(screen.getByTestId("sso-verify-acme-entra")).toBeTruthy();
    expect(screen.queryByTestId("sso-verify-acme-okta")).toBeNull();
  });

  it("verifies the domain and re-reads the page", async () => {
    actions.verifySsoDomain.mockResolvedValue({
      ok: true,
      value: { domainVerified: true },
    });
    await renderSection({ ok: true, value: BOTH });
    await userEvent.click(screen.getByTestId("sso-verify-acme-entra"));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(actions.verifySsoDomain).toHaveBeenCalledWith("acme", "acme-entra");
  });

  it("says the record was not found yet, and what to do (negative)", async () => {
    actions.verifySsoDomain.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "dns_record_not_found",
    });
    await renderSection({ ok: true, value: BOTH });
    await userEvent.click(screen.getByTestId("sso-verify-acme-entra"));
    expect(
      await screen.findByTestId("sso-verify-acme-entra-failure"),
    ).toHaveTextContent("The TXT record was not found");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("requires SSO once a domain is verified", async () => {
    actions.setSsoRequired.mockResolvedValue({
      ok: true,
      value: { ssoRequired: true },
    });
    await renderSection({ ok: true, value: BOTH });
    const toggle = screen.getByRole("switch", {
      name: "Require SSO for members",
    });
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(actions.setSsoRequired).toHaveBeenCalledWith("acme", true);
    });
  });

  it("asks before it deletes a provider, in the page", async () => {
    actions.deleteSsoProvider.mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });
    await renderSection({ ok: true, value: BOTH });
    const row = screen
      .getByRole("table", { name: "Identity providers" })
      .querySelector('[data-provider="acme-okta"]');
    if (!(row instanceof HTMLElement)) throw new Error("provider row missing");
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(actions.deleteSsoProvider).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("sso-delete-acme-okta");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete provider" }),
    );
    await waitFor(() => {
      expect(actions.deleteSsoProvider).toHaveBeenCalledWith(
        "acme",
        "acme-okta",
      );
    });
  });
});

describe("Sso: a plan without SSO", () => {
  const LAPSED = ssoSettings({
    providers: [ssoProvider(), samlProvider()],
    entitled: false,
  });

  it("says SSO is part of the Enterprise plan and links to Billing", async () => {
    const { container } = await renderSection({ ok: true, value: LAPSED });
    const notice = screen.getByTestId("sso-plan-notice");
    expect(notice).toHaveTextContent(
      "Single sign-on is part of the Enterprise plan.",
    );
    expect(notice).toHaveTextContent("no longer sign anyone in");
    expect(
      within(notice).getByRole("link", { name: "Change the plan on Billing." }),
    ).toHaveAttribute("href", "/acme/billing");
    await expectNoAxe(container);
  });

  it("offers no setup control, and keeps Delete on each provider (negative)", async () => {
    await renderSection({ ok: true, value: LAPSED });
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTestId("sso-verify-acme-entra")).toBeNull();
    expect(
      screen.queryByText(
        "Only an Owner or an Admin can change single sign-on.",
      ),
    ).toBeNull();
    const row = screen
      .getByRole("table", { name: "Identity providers" })
      .querySelector('[data-provider="acme-entra"]');
    expect(
      within(asElement(row)).getByRole("button", { name: "Delete" }),
    ).toBeTruthy();
  });

  it("hides Require SSO while it is off (negative)", async () => {
    await renderSection({ ok: true, value: LAPSED });
    expect(
      screen.queryByRole("switch", { name: "Require SSO for members" }),
    ).toBeNull();
  });

  it("lets an Owner turn a leftover Require SSO off, and not back on", async () => {
    actions.setSsoRequired.mockResolvedValue({
      ok: true,
      value: { ssoRequired: false },
    });
    await renderSection({
      ok: true,
      value: { ...LAPSED, policy: { ssoRequired: true } },
    });
    expect(
      screen.getByText(/Require SSO does not apply on your current plan/),
    ).toBeTruthy();
    const toggle = screen.getByRole("switch", {
      name: "Require SSO for members",
    });
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(actions.setSsoRequired).toHaveBeenCalledWith("acme", false);
    });
  });

  it("says so without a provider list when there is none", async () => {
    await renderSection({
      ok: true,
      value: ssoSettings({ providers: [], entitled: false }),
    });
    expect(screen.getByTestId("sso-plan-notice")).not.toHaveTextContent(
      "no longer sign anyone in",
    );
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
  });

  it("names the plan when a write is refused for it", async () => {
    actions.verifySsoDomain.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "sso_requires_enterprise",
    });
    await renderSection({ ok: true, value: BOTH });
    await userEvent.click(screen.getByTestId("sso-verify-acme-entra"));
    expect(
      await screen.findByTestId("sso-verify-acme-entra-failure"),
    ).toHaveTextContent("Single sign-on is part of the Enterprise plan.");
  });
});

describe("Sso: a viewer who cannot write", () => {
  it("shows the providers with no control (negative)", async () => {
    await renderSection({ ok: true, value: BOTH }, "member");
    expect(
      screen.getByText("Only an Owner or an Admin can change single sign-on."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTestId("sso-verify-acme-entra")).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Require SSO for members" }),
    ).toBeDisabled();
  });
});

describe("Sso: a read that did not list", () => {
  it("denied: says who can see it, keeps the tabs, and shows no control (negative)", async () => {
    const { container } = await renderSection({
      ok: false,
      reason: "denied",
      permission: "list_sso_providers",
    });
    expect(screen.getByTestId("sso-denied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
    // Single sign-on is not one of the design's seven tabs: the row stays,
    // and no tab is marked current on this page.
    const tabs = within(
      screen.getByRole("navigation", { name: "Organization" }),
    ).getAllByRole("link");
    expect(tabs).toHaveLength(7);
    expect(tabs.some((tab) => tab.hasAttribute("aria-current"))).toBe(false);
    await expectNoAxe(container);
  });

  it("error: replaces only the section body", async () => {
    await renderSection(readError("kernel_failure", 503));
    expect(screen.getByText(/kernel_failure/)).toHaveAttribute(
      "data-reason",
      "error",
    );
    expect(screen.getByRole("link", { name: /^Roles/ })).toBeTruthy();
  });
});

describe("sso rules mirror the contract", () => {
  it("offers exactly the contract's protocols and mappable roles, and never owner", async () => {
    const shared = await import("@oxagen/oxagen/contracts/org.sso.shared");
    expect([...SSO_PROTOCOLS].sort()).toEqual(
      [...shared.ssoProtocolSchema.options].sort(),
    );
    expect([...SSO_ROLES].sort()).toEqual(
      [...shared.SSO_MAPPABLE_ROLES].sort(),
    );
    expect(SSO_ROLES).not.toContain("owner");
  });
});
