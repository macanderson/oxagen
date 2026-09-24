// @vitest-environment jsdom
// Organization › Model funding and routes (pages/organization.md): the tab
// renders inside the Organization frame, with Funding source first and Model
// routes second. A stored customer key makes the source customer_key and
// carries the key form. Without one the page cannot tell the minted key from
// the shared key (#4005), so the badge says so and the minted key's facts are
// not recorded, with Mint a key, Rotate and Revoke as stubs that send nothing.
// Model routes draws §4.5's four tiers with every stored figure not recorded
// (#4006) and the Total labelled with its basis, client_attested. A viewer
// below Owner or Admin gets the frame's denied state before the read.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCredential } from "@/data/contracts/org";
import { type Read, readError, readOk } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/acme/model-funding",
}));
vi.mock("./model-funding-actions", () => ({
  testModelKey: vi.fn(),
  saveModelKey: vi.fn(),
  removeModelKey: vi.fn(),
}));
vi.mock("./actions", () => ({
  sendInvitation: vi.fn(),
  createWorkspace: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({
  systemLookups: { mfaPolicy: () => Promise.resolve(null) },
}));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { orgSource, roleCatalog, roleRow, workspaceRow } = await import(
  "./organization.builders"
);
const { OrganizationFrame } = await import("./frame");
const { OrganizationModelFunding } = await import("./organization");
const { needsBaseUrl, needsModelMap, MODEL_PROVIDERS } = await import(
  "./model-funding-rules"
);

const STORED: ModelCredential = {
  configured: true,
  provider: "openrouter",
  status: "active",
  keyHint: "wxyz",
  baseUrl: null,
  modelMap: {},
  lastVerifiedAt: null,
  rotatedAt: "2026-09-18T11:00:00.000Z",
};

const NONE: ModelCredential = {
  configured: false,
  provider: null,
  status: null,
  keyHint: null,
  baseUrl: null,
  modelMap: {},
  lastVerifiedAt: null,
  rotatedAt: null,
};

beforeEach(() => {
  getSession.mockResolvedValue({
    user: { name: "Marcus Bell", email: "marcus@acme.example" },
  });
});
afterEach(cleanup);

/**
 * The page the way the route renders it: the tab's body inside the frame,
 * which reads the members, the roles and the workspaces, then hands over to
 * the tab's own read.
 */
async function renderTab(read: Read<ModelCredential>, role: OrgRole = "owner") {
  const ctx = unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: role,
  });
  const { source, calls } = orgSource({
    members: readOk({ members: [], invitations: [] }),
    roles: readOk(roleCatalog({ roles: [roleRow()] })),
    workspaces: readOk({ workspaces: [workspaceRow()] }),
    modelCredential: read,
  });
  // The route hands the frame its props; render the frame with the same ones.
  const page: ReactElement<ComponentProps<typeof OrganizationFrame>> =
    OrganizationModelFunding({ ctx, source });
  const view = render(
    <IntlProvider>{await OrganizationFrame(page.props)}</IntlProvider>,
  );
  return { view, calls };
}

const funding = () => screen.getByRole("region", { name: "Funding source" });
const routesPanel = () => screen.getByRole("region", { name: "Model routes" });

describe("the frame", () => {
  it("draws the Organization header and tabs, with Model funding and routes current", async () => {
    const { calls } = await renderTab(readOk(STORED));
    expect(
      screen.getByRole("heading", { level: 1, name: "Acme Robotics" }),
    ).toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: "Model funding and routes" });
    expect(tab).toHaveAttribute("aria-current", "page");
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getAllByRole("button", { name: "Create a workspace" }),
    ).toHaveLength(1);
    expect(calls.modelCredential).toHaveLength(1);
    // Funding source comes first, then Model routes.
    expect(
      funding().compareDocumentPosition(routesPanel()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("refuses a member below Owner or Admin before the credential is read (negative)", async () => {
    const { calls } = await renderTab(readOk(STORED), "member");
    expect(
      screen.getByRole("heading", {
        name: /You cannot see this organization.s settings/,
      }),
    ).toBeInTheDocument();
    expect(calls.modelCredential).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Funding source" })).toBeNull();
  });
});

describe("Funding source", () => {
  it("reads customer_key off a stored key, with its facts and the key form", async () => {
    const { view } = await renderTab(readOk(STORED));
    const panel = funding();
    expect(panel.querySelector("[data-source]")).toHaveTextContent(
      "customer_key",
    );
    expect(within(panel).getByLabelText("Source")).toHaveValue("customer_key");
    expect(panel).toHaveTextContent("ends in wxyz");
    expect(within(panel).getByTestId("funding-form")).toBeInTheDocument();
    expect(within(panel).queryByTestId("funding-preview")).toBeNull();
    await expectNoAxe(view.container);
  });

  it("chooses no source without a customer key, and states no key as the one that pays (trust, #4005)", async () => {
    const { view } = await renderTab(readOk(NONE));
    const panel = funding();
    expect(
      panel.querySelector('[data-source="not-recorded"]'),
    ).toHaveTextContent("source not recorded");
    const source = within(panel).getByLabelText("Source");
    expect(source).toHaveValue("");
    expect(
      within(source)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Choose a source",
      "platform_minted — one key minted for this organization on Oxagen’s OpenRouter account",
      "platform — Oxagen’s shared account",
      "customer_key — your own OpenRouter or vendor key",
    ]);
    expect(panel).toHaveTextContent(
      "No capability reads which one yet (#4005)",
    );
    // No state is drawn, so nothing says which of Oxagen's keys pays.
    expect(panel.querySelector("[data-funding-state]")).toBeNull();
    expect(panel).not.toHaveTextContent(
      "Oxagen pays the provider and bills the tokens as assistant usage",
    );
    await expectNoAxe(view.container);
  });

  it("marks the shared account a preview when the person picks it", async () => {
    await renderTab(readOk(NONE));
    const panel = funding();
    await userEvent.selectOptions(
      within(panel).getByLabelText("Source"),
      "platform",
    );
    expect(within(panel).getByTestId("funding-preview")).toHaveTextContent(
      "Preview of platform. No capability reads which source pays for this organization yet (#4005).",
    );
  });

  it("previews the minted key's two states apart: a held key with Rotate, Revoke and Reconciliation, and no key with Mint a key", async () => {
    const { view } = await renderTab(readOk(NONE));
    const panel = funding();
    await userEvent.selectOptions(
      within(panel).getByLabelText("Source"),
      "platform_minted",
    );
    const minted = panel.querySelector<HTMLElement>(
      '[data-funding-state="platform_minted"]',
    );
    const state = minted?.querySelector<HTMLElement>('[data-key-state="held"]');
    const none = minted?.querySelector<HTMLElement>('[data-key-state="none"]');
    if (!state || !none) throw new Error("no minted states");
    expect(
      within(state).getByRole("heading", { name: "Minted key" }),
    ).toBeInTheDocument();
    expect(
      within(none).getByRole("heading", { name: "No key" }),
    ).toBeInTheDocument();
    for (const fact of [
      "Secret",
      "Provisioned id",
      "Name on the account",
      "Minted",
      "Monthly cap",
      "Reads",
      "Engine",
    ]) {
      expect(state).toHaveTextContent(fact);
    }
    // Seven facts, then the three Reconciliation rows.
    expect(state.querySelectorAll("[data-not-recorded]")).toHaveLength(10);
    const reconciliation = state.querySelector<HTMLElement>(
      "[data-reconciliation]",
    );
    if (reconciliation === null) throw new Error("no reconciliation");
    for (const row of ["OpenRouter reports", "Our credit ledger", "Difference"])
      expect(reconciliation).toHaveTextContent(row);
    // Difference is never computed from two unread figures.
    expect(reconciliation.querySelectorAll("[data-not-recorded]")).toHaveLength(
      3,
    );
    expect(reconciliation).toHaveAttribute("data-issue", "4005");
    for (const stub of ["Rotate", "Revoke"]) {
      expect(within(state).getByRole("button", { name: stub })).toHaveAttribute(
        "data-stub",
      );
    }
    // Mint a key is the no-key state's, never beside Rotate and Revoke.
    expect(
      within(state).queryByRole("button", { name: "Mint a key" }),
    ).toBeNull();
    expect(none).toHaveTextContent(
      "With no key the in-app agent cannot run, and nothing has been charged.",
    );
    await expectNoAxe(view.container);
    await userEvent.click(
      within(none).getByRole("button", { name: "Mint a key" }),
    );
    const dialog = screen.getByTestId("funding-mint-key");
    expect(dialog).toHaveTextContent("Mint a model key for Acme Robotics");
    expect(dialog).toHaveTextContent("so nothing is sent (#4005)");
  });

  it("lists the three sources in Change source, marking the current one", async () => {
    await renderTab(readOk(STORED));
    await userEvent.click(
      within(funding()).getByRole("button", { name: "Change source" }),
    );
    const dialog = screen.getByTestId("funding-change-source");
    expect(dialog).toHaveTextContent("Change funding source");
    const options = [...dialog.querySelectorAll("[data-source-option]")].map(
      (li) => li.getAttribute("data-source-option"),
    );
    expect(options).toEqual(["platform_minted", "platform", "customer_key"]);
    expect(
      dialog.querySelector('[data-source-option="customer_key"]'),
    ).toHaveTextContent("current");
    expect(
      dialog.querySelector('[data-source-option="platform_minted"]'),
    ).toHaveTextContent("reconciles per organization");
  });

  it("names a failed read inside the panel and keeps Model routes (negative)", async () => {
    await renderTab(readError("kernel_failure", 503));
    expect(within(funding()).queryByTestId("funding-form")).toBeNull();
    expect(funding()).toHaveTextContent("kernel_failure");
    expect(routesPanel()).toBeInTheDocument();
  });
});

describe("Model routes", () => {
  it("states the design's fact in a caption with no comma, and the second fact in a note", async () => {
    await renderTab(readOk(STORED));
    const panel = routesPanel();
    const caption = panel.querySelector("[data-caption]");
    expect(caption).toHaveTextContent(
      /^customer agents call their providers with their own keys$/,
    );
    expect(caption?.textContent).not.toContain(",");
    expect(panel).toHaveTextContent(
      "Oxagen records what each harness reports.",
    );
  });

  it("draws the design's columns and §4.5's four tiers", async () => {
    await renderTab(readOk(STORED));
    const table = within(routesPanel()).getByRole("table", {
      name: "Model routes",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Tier", "Provider", "Route", "Fallback", "Use", "Cost", ""]);
    expect(
      [...table.querySelectorAll("[data-route]")].map((tr) =>
        tr.getAttribute("data-route"),
      ),
    ).toEqual(["complex", "light", "embed", "rerank"]);
  });

  it("says not recorded for every stored figure rather than a guess, and names the issue (#4006)", async () => {
    await renderTab(readOk(STORED));
    const panel = routesPanel();
    const complex = panel.querySelector<HTMLElement>('[data-route="complex"]');
    if (complex === null) throw new Error("no complex row");
    expect(complex.querySelectorAll("[data-not-recorded]")).toHaveLength(5);
    expect(panel).toHaveTextContent(
      "Oxagen’s own model routes are not stored per organization yet",
    );
    expect(panel).toHaveAttribute("data-issue", "4006");
  });

  it("labels the Total with its basis, client_attested, and prints no figure (trust)", async () => {
    await renderTab(readOk(STORED));
    const total =
      routesPanel().querySelector<HTMLElement>("[data-route-total]");
    if (total === null) throw new Error("no total");
    expect(total).toHaveTextContent("Total");
    expect(total.querySelector("[data-basis]")).toHaveTextContent(
      "basis client_attested",
    );
    expect(total).toHaveTextContent("USD");
    expect(total).not.toHaveTextContent("$");
    expect(total.querySelector("[data-not-recorded]")).not.toBeNull();
  });

  it("opens Edit as a stub that says what it would save and sends nothing", async () => {
    await renderTab(readOk(STORED));
    const complex = routesPanel().querySelector<HTMLElement>(
      '[data-route="complex"]',
    );
    if (complex === null) throw new Error("no complex row");
    await userEvent.click(
      within(complex).getByRole("button", { name: "Edit" }),
    );
    const dialog = screen.getByTestId("edit-route-complex");
    expect(dialog).toHaveTextContent("Edit the complex route");
    expect(dialog).toHaveTextContent("so nothing is sent (#4006)");
  });
});

describe("model-funding rules mirror the contract", () => {
  it("agrees with the contract on which vendors need a URL and which need models", async () => {
    const shared = await import(
      "@oxagen/oxagen/contracts/org.model_credential.shared"
    );
    expect([...MODEL_PROVIDERS].sort()).toEqual(
      [...shared.modelCredentialProviderSchema.options].sort(),
    );
    for (const provider of MODEL_PROVIDERS) {
      expect(needsBaseUrl(provider)).toBe(
        shared.requiresCustomerBaseUrl(provider),
      );
      expect(needsModelMap(provider)).toBe(shared.requiresModelMap(provider));
    }
  });
});
