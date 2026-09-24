// @vitest-environment jsdom
// The Add a provider wizard's registry and OAuth paths (#4132), walked the way
// the definition of done asks: find Linear in the registry and authorize it,
// then find Slack, bring the workspace's OAuth app, and authorize it, all in
// the one dialog. The popup is a stub window; its outcome arrives as the
// callback page sends it, a same-origin message carrying the flow's state.
// Also: a message for another flow is ignored, a declined sign-in is named, a
// blocked popup is offered as a link, a server that asks for no OAuth connects
// open, a bearer-token server never takes the OAuth path, a custom server
// signs in with OAuth, and a stdio-only server cannot be selected. axe checks
// the state each test ends in (INV-26).
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryServer } from "@/data/contracts/tools";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { stubPopup } from "@/test/popup";

const {
  router,
  importTools,
  registerServer,
  searchRegistry,
  startProviderAuthorization,
  navigatePopup,
  providerRedirectUrl,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  importTools: vi.fn(),
  registerServer: vi.fn(),
  searchRegistry: vi.fn(),
  startProviderAuthorization: vi.fn(),
  navigatePopup: vi.fn(),
  providerRedirectUrl: vi.fn(),
}));
vi.mock("@/ui/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/navigation")>()),
  navigatePopup,
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ importTools, registerServer }));
vi.mock("./provider-auth-actions", () => ({
  searchRegistry,
  startProviderAuthorization,
  providerRedirectUrl,
}));
vi.mock("@/features/shell/client", () => ({ chooseServerTools: vi.fn() }));

const { ImportProvider } = await import("./import-provider");

const at = { org: "acme", ws: "core-platform" };
const oauth = translator("tools.import.oauth");
const browse = translator("tools.import.browse");
const STATE_LINEAR = "l".repeat(32);
const STATE_SLACK = "s".repeat(32);

function server(over: Partial<RegistryServer>): RegistryServer {
  return {
    registryRef: "verified/linear",
    name: "Linear",
    description: "Issues, projects and cycles in Linear.",
    publisher: "linear.app",
    publisherVerified: true,
    source: "verified",
    version: null,
    iconUrl: "https://linear.app/favicon.ico",
    websiteUrl: "https://linear.app",
    docsUrl: "https://linear.app/docs/mcp",
    repositoryUrl: null,
    endpointUrl: "https://mcp.linear.app/mcp",
    transports: ["streamable-http"],
    auth: "oauth",
    authHeader: null,
    oauthRegistration: "dynamic",
    connectable: true,
    ...over,
  };
}

const LINEAR = server({});
const SLACK = server({
  registryRef: "verified/slack",
  name: "Slack",
  publisher: "slack.com",
  iconUrl: "https://slack.com/favicon.ico",
  endpointUrl: "https://mcp.slack.com/mcp",
  docsUrl: "https://docs.slack.dev/ai/mcp-server",
  oauthRegistration: "client_required",
});
const KEYED = server({
  registryRef: "com.acme/keyed",
  name: "Acme",
  publisher: "acme.com",
  source: "registry",
  iconUrl: null,
  endpointUrl: "https://mcp.acme.example/mcp",
  auth: "bearer",
  authHeader: "Authorization",
  oauthRegistration: null,
});
const LOCAL = server({
  registryRef: "io.github.someone/local",
  name: "Local files",
  publisher: "github.com/someone",
  publisherVerified: false,
  source: "registry",
  endpointUrl: null,
  transports: ["stdio"],
  auth: "none",
  oauthRegistration: null,
  connectable: false,
});

function page(
  servers: readonly RegistryServer[],
  nextCursor: string | null = null,
) {
  return {
    ok: true,
    value: { servers, nextCursor, registryReachable: true },
  };
}

let popup: ReturnType<typeof stubPopup>;

function openWizard() {
  render(
    <IntlProvider>
      <ImportProvider at={at} servers={[]} label="add" primary />
    </IntlProvider>,
  );
  fireEvent.click(screen.getByTestId("tools-import-open"));
}

function search(query: string) {
  fireEvent.change(screen.getByLabelText(browse("search")), {
    target: { value: query },
  });
}

/** What the callback page posts back to the wizard. */
function callback(message: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "oxagen:mcp-oauth", ...message },
        origin: window.origin,
      }),
    );
  });
}

beforeEach(() => {
  for (const fn of [
    router.refresh,
    importTools,
    registerServer,
    searchRegistry,
    startProviderAuthorization,
  ]) {
    fn.mockReset();
  }
  navigatePopup.mockReset();
  providerRedirectUrl.mockReset().mockResolvedValue({
    ok: true,
    value: { redirectUrl: "https://app.oxagen.sh/api/v1/mcp/oauth/callback" },
  });
  popup = stubPopup();
  searchRegistry.mockImplementation(
    (_org: string, _ws: string, input: { query: string }) =>
      Promise.resolve(
        page(
          input.query === "slack"
            ? [SLACK]
            : input.query === "acme"
              ? [KEYED, LOCAL]
              : [LINEAR],
        ),
      ),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  popup.remove();
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Add a provider › registry and OAuth", () => {
  it("authorizes Linear and then Slack from the one wizard, without leaving it", async () => {
    openWizard();
    // Linear: pick it from the registry and sign in in the popup.
    const card = await screen.findByTestId(
      "registry-browser-pick-verified/linear",
    );
    const linearCard = card.closest("li");
    if (!(linearCard instanceof HTMLElement)) throw new Error("no card");
    expect(within(linearCard).getByText("Linear")).toBeVisible();
    expect(
      within(linearCard).getByText("by linear.app (verified domain)"),
    ).toBeVisible();
    expect(within(linearCard).getByText("streamable-http")).toBeVisible();
    expect(within(linearCard).getByText("OAuth")).toBeVisible();
    expect(
      within(linearCard).getByRole("link", { name: "Website" }),
    ).toHaveAttribute("href", "https://linear.app/");
    expect(linearCard.querySelector("img")).toHaveAttribute(
      "referrerpolicy",
      "no-referrer",
    );
    fireEvent.click(card);
    startProviderAuthorization.mockResolvedValueOnce({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "https://mcp.linear.app/authorize?state=l",
        state: STATE_LINEAR,
      },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    await waitFor(() => {
      expect(navigatePopup).toHaveBeenLastCalledWith(
        popup.win,
        "https://mcp.linear.app/authorize?state=l",
      );
    });
    expect(startProviderAuthorization).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        mode: "add",
        name: "Linear",
        endpointUrl: "https://mcp.linear.app/mcp",
        registryId: "verified/linear",
        iconUrl: "https://linear.app/favicon.ico",
        description: "Issues, projects and cycles in Linear.",
      },
    );
    expect(
      screen.getByText(oauth("waiting", { name: "Linear" })),
    ).toBeVisible();
    // A message for another flow does nothing.
    callback({
      ok: true,
      state: "x".repeat(32),
      serverId: "mcs_x",
      name: "X",
      healthStatus: "healthy",
      discoveredTools: [],
    });
    expect(screen.getByTestId("tools-import-oauth-waiting")).toBeVisible();
    callback({
      ok: true,
      state: STATE_LINEAR,
      serverId: "mcs_linear",
      name: "Linear",
      healthStatus: "healthy",
      discoveredTools: ["list_issues", "create_issue"],
    });
    expect(await screen.findByText("Review tools/list")).toBeVisible();
    expect(screen.getByTestId("tools-import-selected")).toHaveTextContent(
      "2 of 2 selected",
    );
    expect(popup.close).toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();

    importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d1", published: 2, unchanged: 0 },
    });
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    fireEvent.click(screen.getByTestId("tools-import-confirm"));
    await screen.findByTestId("tools-import-done");

    // Slack, in the same dialog: add another, browse again.
    fireEvent.click(screen.getByTestId("tools-import-another"));
    search("slack");
    fireEvent.click(
      await screen.findByTestId("registry-browser-pick-verified/slack"),
    );
    // Slack registers no OAuth apps itself: the client form is open and required.
    const clientForm = screen.getByTestId("tools-import-client-required");
    expect(within(clientForm).getByLabelText(oauth("clientId"))).toBeRequired();
    // The redirect URL to register the Slack app with is there before any attempt.
    expect(
      await within(clientForm).findByTestId("tools-import-redirect-url"),
    ).toHaveTextContent("https://app.oxagen.sh/api/v1/mcp/oauth/callback");
    startProviderAuthorization.mockResolvedValueOnce({
      ok: true,
      value: {
        status: "client_required",
        scopesSupported: ["chat:write", "channels:read"],
        redirectUrl: "https://app.oxagen.sh/api/v1/mcp/oauth/callback",
      },
    });
    fireEvent.change(screen.getByLabelText(oauth("clientId")), {
      target: { value: "123.456" },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    // The server answered client_required: the redirect URL to register and
    // the scopes it advertises are shown.
    expect(
      await screen.findByTestId("tools-import-redirect-url"),
    ).toHaveTextContent("https://app.oxagen.sh/api/v1/mcp/oauth/callback");
    expect(screen.getByLabelText(oauth("scopes"))).toHaveValue(
      "chat:write channels:read",
    );
    fireEvent.change(screen.getByLabelText(oauth("clientId")), {
      target: { value: "123.456" },
    });
    fireEvent.change(screen.getByLabelText(oauth("clientSecret")), {
      target: { value: "slack-secret" },
    });
    startProviderAuthorization.mockResolvedValueOnce({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "https://slack.com/oauth/v2_user/authorize?state=s",
        state: STATE_SLACK,
      },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    await waitFor(() => {
      expect(navigatePopup).toHaveBeenLastCalledWith(
        popup.win,
        "https://slack.com/oauth/v2_user/authorize?state=s",
      );
    });
    expect(startProviderAuthorization).toHaveBeenLastCalledWith(
      "acme",
      "core-platform",
      {
        mode: "add",
        name: "Slack",
        endpointUrl: "https://mcp.slack.com/mcp",
        registryId: "verified/slack",
        iconUrl: "https://slack.com/favicon.ico",
        description: "Issues, projects and cycles in Linear.",
        client: {
          clientId: "123.456",
          clientSecret: "slack-secret",
          scopes: "chat:write channels:read",
        },
      },
    );
    callback({
      ok: true,
      state: STATE_SLACK,
      serverId: "mcs_slack",
      name: "Slack",
      healthStatus: "healthy",
      discoveredTools: ["send_message"],
    });
    expect(
      await screen.findByTestId("tools-import-selected"),
    ).toHaveTextContent("1 of 1 selected");
    expect(document.body.textContent).not.toContain("slack-secret");
  });

  it("names a declined sign-in and stays on Connect", async () => {
    openWizard();
    fireEvent.click(
      await screen.findByTestId("registry-browser-pick-verified/linear"),
    );
    startProviderAuthorization.mockResolvedValue({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "https://mcp.linear.app/a",
        state: STATE_LINEAR,
      },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    await screen.findByTestId("tools-import-oauth-waiting");
    callback({ ok: false, state: STATE_LINEAR, code: "access_denied" });
    expect(
      await screen.findByTestId("tools-import-oauth-failure"),
    ).toHaveTextContent(oauth("failure.access_denied"));
    expect(screen.queryByText("Review tools/list")).not.toBeInTheDocument();
  });

  it("offers the sign-in page as a link when the browser blocked the popup", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    openWizard();
    fireEvent.click(
      await screen.findByTestId("registry-browser-pick-verified/linear"),
    );
    startProviderAuthorization.mockResolvedValue({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "https://mcp.linear.app/a",
        state: STATE_LINEAR,
      },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    expect(
      await screen.findByTestId("tools-import-oauth-open"),
    ).toHaveAttribute("href", "https://mcp.linear.app/a");
  });

  it("names a refused start without opening anything further", async () => {
    openWizard();
    fireEvent.click(
      await screen.findByTestId("registry-browser-pick-verified/linear"),
    );
    startProviderAuthorization.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    expect(
      await screen.findByTestId("tools-import-oauth-failure"),
    ).toHaveTextContent(oauth("failure.org_role_required"));
    expect(popup.close).toHaveBeenCalled();
  });

  it("connects a server that turns out to ask for no OAuth, without sign-in", async () => {
    searchRegistry.mockResolvedValue(
      page([server({ auth: "unknown", oauthRegistration: null })]),
    );
    registerServer.mockResolvedValue({
      ok: true,
      value: {
        serverId: "mcs_open",
        healthStatus: "healthy",
        discoveredTools: ["ping"],
      },
    });
    openWizard();
    fireEvent.click(
      await screen.findByTestId("registry-browser-pick-verified/linear"),
    );
    startProviderAuthorization.mockResolvedValue({
      ok: true,
      value: { status: "not_oauth" },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    fireEvent.click(await screen.findByTestId("tools-import-connect-open"));
    await waitFor(() => {
      expect(registerServer).toHaveBeenCalledWith("acme", "core-platform", {
        name: "Linear",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.linear.app/mcp",
        authStrategy: "none",
        authConfig: {},
      });
    });
    expect(await screen.findByText("Review tools/list")).toBeVisible();
  });

  it("registers a bearer-token server with the token typed, never over OAuth", async () => {
    registerServer.mockResolvedValue({
      ok: true,
      value: {
        serverId: "mcs_acme",
        healthStatus: "healthy",
        discoveredTools: [],
      },
    });
    openWizard();
    search("acme");
    fireEvent.click(
      await screen.findByTestId("registry-browser-pick-com.acme/keyed"),
    );
    fireEvent.change(screen.getByLabelText(browse("token")), {
      target: { value: "sk-acme" },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    await waitFor(() => {
      expect(registerServer).toHaveBeenCalledWith("acme", "core-platform", {
        name: "Acme",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.acme.example/mcp",
        authStrategy: "bearer",
        authConfig: { token: "sk-acme" },
      });
    });
    expect(startProviderAuthorization).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("sk-acme");
  });

  it("lists a stdio-only server with the reason and no Select", async () => {
    openWizard();
    search("acme");
    const card = (await screen.findByText("Local files")).closest("li");
    if (!(card instanceof HTMLElement)) throw new Error("no card");
    expect(within(card).getByText(browse("stdioOnly"))).toBeVisible();
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    expect(within(card).getByText("by github.com/someone")).toBeVisible();
  });

  it("signs in to a custom internal server with OAuth", async () => {
    openWizard();
    fireEvent.click(screen.getByTestId("tools-import-source-custom"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Internal" },
    });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), {
      target: { value: "https://mcp.internal.example/mcp" },
    });
    startProviderAuthorization.mockResolvedValue({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "https://sso.internal.example/authorize",
        state: STATE_LINEAR,
      },
    });
    fireEvent.click(screen.getByTestId("tools-import-connect"));
    await waitFor(() => {
      expect(navigatePopup).toHaveBeenLastCalledWith(
        popup.win,
        "https://sso.internal.example/authorize",
      );
    });
    expect(startProviderAuthorization).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        mode: "add",
        name: "Internal",
        endpointUrl: "https://mcp.internal.example/mcp",
      },
    );
    callback({
      ok: true,
      state: STATE_LINEAR,
      serverId: "mcs_int",
      name: "Internal",
      healthStatus: "healthy",
      discoveredTools: ["query"],
    });
    expect(await screen.findByText("Review tools/list")).toBeVisible();
  });

  it("says when the registry could not be read, and pages through more results", async () => {
    searchRegistry
      .mockResolvedValueOnce({
        ok: true,
        value: { servers: [LINEAR], nextCursor: "c2", registryReachable: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { servers: [KEYED], nextCursor: null, registryReachable: true },
      });
    openWizard();
    fireEvent.click(await screen.findByTestId("registry-browser-more"));
    expect(await screen.findByText("Acme")).toBeVisible();
    expect(screen.getByText("Linear")).toBeVisible();
    expect(searchRegistry).toHaveBeenLastCalledWith("acme", "core-platform", {
      query: "",
      cursor: "c2",
    });
    cleanup();
    searchRegistry.mockResolvedValue({
      ok: true,
      value: { servers: [], nextCursor: null, registryReachable: false },
    });
    openWizard();
    expect(
      await screen.findByTestId("registry-browser-unreachable"),
    ).toBeVisible();
  });
});
