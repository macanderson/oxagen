// @vitest-environment jsdom
// A Studio server's Connection tab (#4678) on the Studio fixtures. It covers
// where each kind of source says the server comes from: a remote server, a
// registry package, a local command, and an OpenAPI, GraphQL or gRPC
// definition. It covers the environments and the one agents call, each auth
// mode, the provider's status light and sign-in, the sync schedule, and the
// tab a server shows before discovery records it. A server the local gateway
// runs shows its machine groups in place of environments and auth. An editor
// sees Replace credential, drawn as not built until lane M8 (#4668) lands,
// and Reconnect for an OAuth provider. A reader sees neither. A credential
// shows only as its vault reference: every fixture is checked for any other
// credential text and for a secret-shaped value in any text or attribute. Each
// address the tab shows hides a URL's user info and any query or fragment
// value whose name reads like a secret (item 12). axe checks the state each
// test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@/data/contracts/tools";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { stubPopup } from "@/test/popup";
import type {
  StudioEnvironment,
  StudioRecord,
  StudioServerView,
  StudioSource,
} from "./model";

// The tab reuses the Tools page's status light, sign-in and Reconnect through
// the `@/features/tools` barrel, which loads the whole Tools page. These are
// the mocks tools.test.tsx sets for that graph, plus the OAuth callback's
// server imports. The record pickers answer an empty list.
const { choices } = vi.hoisted(() => {
  const none = () =>
    Promise.resolve({ ok: true, value: { options: [], partial: false } });
  return {
    choices: {
      chooseAgents: vi.fn(none),
      chooseApprovers: vi.fn(none),
      chooseMcpServers: vi.fn(none),
      chooseModels: vi.fn(none),
      chooseRuns: vi.fn(none),
      chooseServerTools: vi.fn(none),
      chooseSwitchTargets: vi.fn(none),
      chooseToolPatterns: vi.fn(none),
    },
  };
});
vi.mock("@/features/shell/client", () => ({
  ...choices,
  openApprovals: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: vi.fn() }));
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const actions = vi.hoisted(() => ({
  importTools: vi.fn(),
  setToolClassification: vi.fn(),
  flipKillSwitch: vi.fn(),
  saveApprovalRule: vi.fn(),
  setApprovalRuleEnabled: vi.fn(),
  deleteApprovalRule: vi.fn(),
  addConnection: vi.fn(),
  readConnection: vi.fn(),
  registerServer: vi.fn(),
  removeProvider: vi.fn(),
  cloneToolbelt: vi.fn(),
  updateToolbelt: vi.fn(),
  deleteToolbelt: vi.fn(),
  setToolState: vi.fn(),
}));
vi.mock("../tools/actions", () => actions);
const { startProviderAuthorization } = vi.hoisted(() => ({
  startProviderAuthorization: vi.fn(),
}));
vi.mock("../tools/provider-auth-actions", () => ({
  searchRegistry: vi.fn(),
  startProviderAuthorization,
  completeProviderAuthorization: vi.fn(),
  providerRedirectUrl: vi.fn().mockResolvedValue({
    ok: true,
    value: { redirectUrl: "https://app.oxagen.sh/api/v1/mcp/oauth/callback" },
  }),
}));

const { ConnectionTab } = await import("./connection-tab");
const {
  BILLING,
  GITHUB,
  SCRATCH,
  STRIPE,
  WAREHOUSE,
  billingRecord,
  localRecord,
  packageRecord,
  stripeRecord,
  studioBoard,
  studioServer,
  studioView,
  versionsOf,
  warehouseTool,
} = await import("./studio.builders");
const { buildStudioView } = await import("./model");

type TabProps = Parameters<typeof ConnectionTab>[0];
type SectionName = "source" | "environments" | "auth" | "machines" | "sync";
type Authorization = NonNullable<McpServer["authorization"]>;

const at = { org: "acme", ws: "core-platform" };

/** The issues a not-built value names in `data-gap` (gaps.ts). */
const RECORD_GAP = "#4678";
const CREDENTIALS_GAP = "#4668";

const connection = translator("mcpStudio.connection");
const term = translator("mcpStudio.connection.facts");
const envs = translator("mcpStudio.connection.environments");
const auth = translator("mcpStudio.connection.auth");
const machines = translator("mcpStudio.connection.machines");
const sync = translator("mcpStudio.connection.sync");
const status = translator("tools.providers.status");
const reconnect = translator("tools.providers.reconnect");
const notRecorded = translator("mcpStudio")("notRecorded");

/** A vault reference: the one form a credential takes on this page. */
const REFERENCE = /^oxagen:credential\/[a-z0-9-]+$/;

/** What a credential value may say: a reference, or that there is none to show. */
const CREDENTIAL_SHOWN = new RegExp(
  `^(?:oxagen:credential/[a-z0-9-]+|—|${envs("noCredential")}|${notRecorded})$`,
);

/**
 * The shapes a live secret takes: a Stripe key, a GitHub or Slack token, an
 * AWS key id, a PEM private key, a JWT, and a URL that carries a password.
 */
const SECRET =
  /\b(?:sk|rk)_(?:live|test)_\w+|\bgh[pousr]_\w{16,}|\bxox[abpr]-\w+|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[\w-]{8,}\.[\w-]{8,}\.|:\/\/[^\s/:@]+:[^\s/@]+@/;

/** A refused refresh: red whatever the clock says, and it does not renew. */
const NEEDS_SIGN_IN: Authorization = {
  state: "needs_reauth",
  expiresAt: "2026-09-30T12:00:00.000Z",
  refreshable: false,
  lastRefreshedAt: null,
};

/** Signed in with no expiry, so the light is green without a clock. */
const SIGNED_IN: Authorization = {
  state: "connected",
  expiresAt: null,
  refreshable: true,
  lastRefreshedAt: null,
};

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    window.sessionStorage.clear();
  }
});

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
  startProviderAuthorization.mockReset();
});

function withIntl(node: ReactNode) {
  return render(<IntlProvider>{node}</IntlProvider>);
}

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}

/** The tab for one server's view, with the props the page passes, and any of them replaced. */
function renderTab(view: StudioServerView, over: Partial<TabProps> = {}) {
  return withIntl(
    <ConnectionTab
      at={at}
      server={view.server}
      record={view.record}
      environments={view.environments}
      agentEnvironment={view.agentEnvironment}
      canEdit
      {...over}
    />,
  );
}

/** A registry server row that signs in with OAuth. No builder makes one. */
function oauthServer(id: string, authorization: Authorization): McpServer {
  return { ...studioServer(id), authKind: "oauth", authorization };
}

function withSource(record: StudioRecord, source: StudioSource): StudioRecord {
  return { ...record, source };
}

const section = (name: SectionName) =>
  screen.getByTestId(`studio-connection-${name}`);

/** The value a section's fact list gives for one term: the <dd> after its <dt>. */
function fact(name: SectionName, label: string): HTMLElement {
  const dt = within(section(name)).getByText(label, { selector: "dt" });
  return element(dt.nextElementSibling, `value of ${label}`);
}

/** The terms a section's fact list shows, in order. */
function termsOf(name: SectionName): string[] {
  return Array.from(section(name).querySelectorAll("dt"), (dt) => dt.textContent);
}

function expectNotRecorded(value: HTMLElement) {
  const marker = element(
    value.querySelector('[data-state="not-recorded"]'),
    "not-recorded value",
  );
  expect(marker).toHaveTextContent(notRecorded);
  expect(marker).toHaveAttribute("data-gap", RECORD_GAP);
}

const ENV_COLUMNS = ["name", "url", "network", "credential", "agents"] as const;

function cellOf(
  env: string,
  column: (typeof ENV_COLUMNS)[number],
): HTMLElement {
  const row = screen.getByTestId(`studio-environment-${env}`);
  return element(
    row.querySelectorAll("td").item(ENV_COLUMNS.indexOf(column)),
    `${column} cell of ${env}`,
  );
}

const light = (serverId: string) =>
  screen.getByTestId(`provider-status-${serverId}`);

/** Whitespace as the matchers see it: ICU puts a narrow no-break space before AM and PM. */
function plain(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** A time as the tab formats it: medium date, short time, in the provider's UTC. */
function dateOf(iso: string): string {
  return plain(
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso)),
  );
}

function lastSyncOf(record: StudioRecord): string {
  const lastAt = record.sync.lastAt;
  if (lastAt === null) throw new Error(`${record.folder} has never synced`);
  return dateOf(lastAt);
}

/** Every non-blank text node under a root: one per string the page renders. */
function textsOf(root: Node): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent;
    if (text !== null && text.trim() !== "") texts.push(text);
  }
  return texts;
}

function attributesOf(root: Element): string[] {
  return Array.from(root.querySelectorAll("*")).flatMap((node) =>
    Array.from(node.attributes, (attribute) => attribute.value),
  );
}

/** Each place the tab shows a credential: every environment's cell and the auth fact. */
function credentialValues(): HTMLElement[] {
  const cells = Array.from(
    document.querySelectorAll('[data-testid^="studio-environment-"]'),
    (row) =>
      element(
        row.querySelectorAll("td").item(ENV_COLUMNS.indexOf("credential")),
        "credential cell",
      ),
  );
  return screen.queryByTestId("studio-connection-auth") === null
    ? cells
    : [...cells, fact("auth", auth("credential"))];
}

describe("Connection tab › source", () => {
  it("shows a remote server's URL, transport and network route, with a green light", () => {
    renderTab(studioView(STRIPE));
    expect(screen.queryByTestId("studio-source-missing")).toBeNull();
    expect(termsOf("source")).toEqual([
      term("type"),
      term("url"),
      term("transport"),
      term("network"),
      term("status"),
    ]);
    expect(fact("source", term("type")).textContent).toBe(
      connection("sourceTypes.remote"),
    );
    expect(fact("source", term("url")).textContent).toBe(
      "https://mcp.stripe.example/v1",
    );
    expect(fact("source", term("transport")).textContent).toBe("http");
    // Pinned as it stands: a recorded `cloud` prints the raw word, while a
    // null route prints "Oxagen cloud". Both mean the same route.
    expect(fact("source", term("network")).textContent).toBe("cloud");
    expect(light(STRIPE)).toHaveAttribute("data-light", "green");
    expect(light(STRIPE)).toHaveAttribute("data-reason", "ok");
    expect(light(STRIPE)).toHaveTextContent(status("lights.green"));
    expect(light(STRIPE)).toHaveTextContent(status("short.ok"));
  });

  it("names the Oxagen cloud for a remote server with no network route", () => {
    renderTab(studioView(SCRATCH));
    expect(fact("source", term("network")).textContent).toBe(
      connection("cloud"),
    );
  });

  it("shows an OpenAPI definition read from a repository with its repository, path and ref", () => {
    renderTab(studioView(BILLING));
    expect(termsOf("source")).toEqual([
      term("type"),
      term("from"),
      term("repo"),
      term("path"),
      term("ref"),
      term("network"),
      term("status"),
    ]);
    expect(fact("source", term("type")).textContent).toBe(
      connection("sourceTypes.openapi"),
    );
    expect(fact("source", term("from")).textContent).toBe(
      connection("from.repository"),
    );
    expect(fact("source", term("repo")).textContent).toBe(
      "github.com/acme/billing-api",
    );
    expect(fact("source", term("path")).textContent).toBe(
      "openapi/billing.yaml",
    );
    expect(fact("source", term("ref")).textContent).toBe("main");
    expect(fact("source", term("network")).textContent).toBe(
      "relay:a-intel-east",
    );
  });

  it("shows a GraphQL schema read by introspection with its URL, and lists none of its 600 tools", () => {
    renderTab(studioView(WAREHOUSE));
    expect(termsOf("source")).toEqual([
      term("type"),
      term("from"),
      term("url"),
      term("network"),
      term("status"),
    ]);
    expect(fact("source", term("type")).textContent).toBe(
      connection("sourceTypes.graphql"),
    );
    expect(fact("source", term("from")).textContent).toBe(
      connection("from.introspection"),
    );
    expect(fact("source", term("url")).textContent).toBe(
      "https://warehouse.example/graphql",
    );
    expect(screen.queryByText(warehouseTool(0))).toBeNull();
    expect(screen.queryByText(warehouseTool(599))).toBeNull();
  });

  it.each<[string, StudioSource, string[], Record<string, string>]>([
    [
      "a gRPC service read by reflection",
      {
        type: "grpc",
        from: "reflection",
        repo: null,
        path: null,
        ref: null,
        url: "https://ledger.internal.example:443",
        network: "relay:a-intel-east",
      },
      [term("type"), term("from"), term("url"), term("network"), term("status")],
      {
        [term("type")]: connection("sourceTypes.grpc"),
        [term("from")]: connection("from.reflection"),
        [term("url")]: "https://ledger.internal.example:443",
        [term("network")]: "relay:a-intel-east",
      },
    ],
    [
      "an OpenAPI definition uploaded as a file",
      {
        type: "openapi",
        from: "upload",
        repo: null,
        path: "billing.yaml",
        ref: null,
        url: null,
        network: null,
      },
      [term("type"), term("from"), term("path"), term("network"), term("status")],
      {
        [term("type")]: connection("sourceTypes.openapi"),
        [term("from")]: connection("from.upload"),
        [term("path")]: "billing.yaml",
        [term("network")]: connection("cloud"),
      },
    ],
    [
      "an OpenAPI definition read from a URL",
      {
        type: "openapi",
        from: "url",
        repo: null,
        path: null,
        ref: null,
        url: "https://billing.internal.example/openapi.json",
        network: "cloud",
      },
      [term("type"), term("from"), term("url"), term("network"), term("status")],
      {
        [term("type")]: connection("sourceTypes.openapi"),
        [term("from")]: connection("from.url"),
        [term("url")]: "https://billing.internal.example/openapi.json",
        [term("network")]: "cloud",
      },
    ],
  ])("shows %s with only the facts it records", (_case, source, terms, values) => {
    renderTab(studioView(BILLING, withSource(billingRecord(), source)));
    expect(termsOf("source")).toEqual(terms);
    for (const [label, value] of Object.entries(values)) {
      expect(fact("source", label).textContent).toBe(value);
    }
  });

  it("shows a registry package's facts and its machine groups in place of environments and auth", () => {
    renderTab(studioView(GITHUB, packageRecord()));
    expect(termsOf("source")).toEqual([
      term("type"),
      term("registry"),
      term("server"),
      term("version"),
      term("packageType"),
      term("machines"),
      term("env"),
      term("status"),
    ]);
    expect(fact("source", term("type")).textContent).toBe(
      connection("sourceTypes.registry"),
    );
    expect(fact("source", term("registry")).textContent).toBe(
      "https://registry.modelcontextprotocol.io",
    );
    expect(fact("source", term("server")).textContent).toBe(
      "io.github.github/github-mcp-server",
    );
    expect(fact("source", term("version")).textContent).toBe("0.9.0");
    expect(fact("source", term("packageType")).textContent).toBe("npm");
    expect(fact("source", term("machines")).textContent).toBe(
      "build-agents, laptops",
    );
    expect(fact("source", term("env")).textContent).toBe("GITHUB_TOKEN");
    expect(section("machines")).toHaveTextContent(machines("body"));
    expect(
      within(section("machines")).getByText("build-agents, laptops"),
    ).toBeVisible();
    expect(screen.queryByTestId("studio-connection-environments")).toBeNull();
    expect(screen.queryByTestId("studio-connection-auth")).toBeNull();
    expect(screen.queryByTestId("studio-credential-replace")).toBeNull();
    // The fixture records a credential, and a machine server is sent none.
    expect(screen.queryByText("oxagen:credential/github-bot")).toBeNull();
  });

  it("says the package type is not recorded and names no variables when a package passes none", () => {
    renderTab(
      studioView(
        GITHUB,
        withSource(packageRecord(), {
          type: "registry",
          registry: "https://registry.modelcontextprotocol.io",
          server: "io.github.github/github-mcp-server",
          version: "0.9.0",
          network: null,
          machines: ["build-agents"],
          registryType: null,
          env: [],
        }),
      ),
    );
    expectNotRecorded(fact("source", term("packageType")));
    expect(fact("source", term("env")).textContent).toBe(connection("none"));
    expect(fact("source", term("machines")).textContent).toBe("build-agents");
  });

  it("treats a registry entry with no machine groups as a remote server with environments and auth", () => {
    renderTab(
      studioView(
        GITHUB,
        withSource(packageRecord(), {
          type: "registry",
          registry: "https://registry.modelcontextprotocol.io",
          server: "io.example/hosted-server",
          version: "1.2.0",
          network: "relay:a-intel-east",
          machines: [],
          registryType: null,
          env: [],
        }),
      ),
    );
    expect(termsOf("source")).toEqual([
      term("type"),
      term("registry"),
      term("server"),
      term("version"),
      term("network"),
      term("status"),
    ]);
    expect(fact("source", term("network")).textContent).toBe(
      "relay:a-intel-east",
    );
    expect(screen.queryByTestId("studio-connection-machines")).toBeNull();
    expect(section("environments")).toBeVisible();
    expect(section("auth")).toBeVisible();
  });

  it("shows a local command with its arguments, machine groups and variable names", () => {
    renderTab(studioView(GITHUB, localRecord()));
    expect(termsOf("source")).toEqual([
      term("type"),
      term("command"),
      term("machines"),
      term("env"),
      term("status"),
    ]);
    expect(fact("source", term("type")).textContent).toBe(
      connection("sourceTypes.local"),
    );
    expect(fact("source", term("command")).textContent).toBe(
      "npx -y @acme/files-mcp",
    );
    expect(fact("source", term("machines")).textContent).toBe("build-agents");
    expect(fact("source", term("env")).textContent).toBe("FILES_ROOT");
    expect(within(section("machines")).getByText("build-agents")).toBeVisible();
    expect(screen.queryByTestId("studio-connection-environments")).toBeNull();
    expect(screen.queryByTestId("studio-connection-auth")).toBeNull();
  });

  it("says no machine groups and no variables for a local command that names none", () => {
    renderTab(
      studioView(
        GITHUB,
        withSource(localRecord(), {
          type: "local",
          command: "uvx",
          args: [],
          env: [],
          machines: [],
        }),
      ),
    );
    expect(fact("source", term("command")).textContent).toBe("uvx");
    expect(fact("source", term("machines")).textContent).toBe(
      connection("noMachines"),
    );
    expect(fact("source", term("env")).textContent).toBe(connection("none"));
    expect(
      within(section("machines")).getByText(machines("none")),
    ).toBeVisible();
  });

  it("shows the registry row and says what is not recorded before discovery records the server", () => {
    renderTab(studioView(GITHUB, null));
    const missing = screen.getByTestId("studio-source-missing");
    expect(missing).toHaveAttribute("role", "note");
    expect(missing).toHaveAttribute("data-gap", RECORD_GAP);
    expect(missing).toHaveTextContent(connection("source.missing"));
    expect(termsOf("source")).toEqual([
      term("type"),
      term("endpoint"),
      term("transport"),
      term("auth"),
      term("status"),
    ]);
    expectNotRecorded(fact("source", term("type")));
    expect(fact("source", term("endpoint")).textContent).toBe(
      "https://mcp.github.example/sse",
    );
    expect(fact("source", term("transport")).textContent).toBe("sse");
    expect(fact("source", term("auth")).textContent).toBe(status("kinds.none"));
    expect(light(GITHUB)).toHaveAttribute("data-light", "yellow");
    expect(light(GITHUB)).toHaveAttribute("data-reason", "unchecked");
    expect(light(GITHUB)).toHaveTextContent(status("lights.yellow"));
    expect(light(GITHUB)).toHaveTextContent(status("short.unchecked"));
    expectNotRecorded(cellOf("default", "credential"));
    expectNotRecorded(fact("auth", auth("credential")));
    expectNotRecorded(fact("sync", sync("schedule")));
    expectNotRecorded(fact("sync", sync("lastAt")));
    const gaps = document.querySelectorAll('[data-state="not-recorded"]');
    expect(gaps).toHaveLength(6);
    for (const gap of gaps) {
      expect(gap).toHaveAttribute("data-gap", RECORD_GAP);
    }
  });
});

describe("Connection tab › layout", () => {
  const order = () =>
    Array.from(screen.getByTestId("studio-connection").children, (child) =>
      child.getAttribute("data-testid"),
    );

  it("orders a remote server's sections as source, environments, authentication and sync, each a named region", () => {
    renderTab(studioView(STRIPE));
    expect(order()).toEqual([
      "studio-connection-source",
      "studio-connection-environments",
      "studio-connection-auth",
      "studio-connection-sync",
    ]);
    for (const title of [
      connection("source.title"),
      envs("title"),
      auth("title"),
      sync("title"),
    ]) {
      expect(screen.getByRole("region", { name: title })).toBeVisible();
    }
  });

  it("orders a machine server's sections as source, machines and sync", () => {
    renderTab(studioView(GITHUB, localRecord()));
    expect(order()).toEqual([
      "studio-connection-source",
      "studio-connection-machines",
      "studio-connection-sync",
    ]);
    expect(screen.getByRole("region", { name: machines("title") })).toBeVisible();
  });
});

describe("Connection tab › environments", () => {
  it("shows a server with no environments of its own as one default environment that agents call", () => {
    renderTab(studioView(STRIPE));
    expect(screen.getByTestId("studio-agent-environment")).toHaveTextContent(
      envs("agentsCall", { name: "default" }),
    );
    const table = screen.getByRole("table", { name: envs("title") });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      envs("columns.name"),
      envs("columns.url"),
      envs("columns.network"),
      envs("columns.credential"),
      envs("columns.agents"),
    ]);
    expect(cellOf("default", "name").textContent).toBe("default");
    expect(cellOf("default", "url").textContent).toBe(
      "https://mcp.stripe.example/v1",
    );
    expect(cellOf("default", "network").textContent).toBe(connection("cloud"));
    expect(cellOf("default", "credential").textContent).toBe(
      "oxagen:credential/stripe-restricted",
    );
    expect(screen.getByTestId("studio-agent-badge-default")).toHaveTextContent(
      envs("agentBadge"),
    );
  });

  it("shows each of two environments, marks the sandbox, and gives the sandbox the agents badge", () => {
    renderTab(studioView(BILLING));
    expect(screen.getByTestId("studio-agent-environment")).toHaveTextContent(
      envs("agentsCall", { name: "sandbox" }),
    );
    expect(
      within(cellOf("sandbox", "name")).getByText(envs("sandbox")),
    ).toBeVisible();
    expect(cellOf("production", "name").textContent).toBe("production");
    expect(cellOf("sandbox", "url").textContent).toBe(
      "https://billing-sandbox.internal.example/v2",
    );
    expect(cellOf("production", "url").textContent).toBe(
      "https://billing.internal.example/v2",
    );
    expect(cellOf("sandbox", "network").textContent).toBe("relay:a-intel-east");
    expect(cellOf("sandbox", "credential").textContent).toBe(
      "oxagen:credential/billing-sandbox",
    );
    expect(cellOf("production", "credential").textContent).toBe(
      "oxagen:credential/billing-production",
    );
    expect(screen.getByTestId("studio-agent-badge-sandbox")).toBeVisible();
    expect(screen.queryByTestId("studio-agent-badge-production")).toBeNull();
    expect(cellOf("production", "agents").textContent).toBe("—");
  });

  it("says no environment is set for agents when two environments mark no sandbox", () => {
    const billing = billingRecord();
    const view = studioView(BILLING, {
      ...billing,
      environments: billing.environments.map((env) => ({
        ...env,
        sandbox: false,
      })),
    });
    expect(view.agentEnvironment).toBeNull();
    renderTab(view);
    expect(screen.getByTestId("studio-agent-environment")).toHaveTextContent(
      envs("agentsUnset"),
    );
    expect(screen.queryAllByTestId(/^studio-agent-badge-/)).toEqual([]);
    expect(cellOf("sandbox", "agents").textContent).toBe("—");
    expect(cellOf("production", "agents").textContent).toBe("—");
    expect(
      within(cellOf("sandbox", "name")).queryByText(envs("sandbox")),
    ).toBeNull();
  });

  it("shows a dash for an environment with no URL and the server's credential for one with none of its own", () => {
    const staging: StudioEnvironment = {
      name: "staging",
      sandbox: true,
      url: null,
      network: null,
      credential: null,
    };
    renderTab(
      studioView(BILLING, { ...billingRecord(), environments: [staging] }),
    );
    expect(cellOf("staging", "url").textContent).toBe("—");
    expect(cellOf("staging", "network").textContent).toBe(connection("cloud"));
    expect(cellOf("staging", "credential").textContent).toBe(
      "oxagen:credential/billing-oauth",
    );
    expect(screen.getByTestId("studio-agent-badge-staging")).toBeVisible();
  });

  it("says a server that needs no credential has none", () => {
    renderTab(studioView(SCRATCH));
    expect(cellOf("default", "credential").textContent).toBe(
      envs("noCredential"),
    );
  });

  it("shows a dash for the credential of a service server that records none", () => {
    renderTab(
      studioView(STRIPE, {
        ...stripeRecord(),
        auth: { mode: "service", scheme: null, credential: null },
      }),
    );
    expect(cellOf("default", "credential").textContent).toBe("—");
    expect(termsOf("auth")).toEqual([auth("mode"), auth("credential")]);
    expect(fact("auth", auth("mode")).textContent).toBe(auth("modes.service"));
    expect(fact("auth", auth("credential")).textContent).toBe("—");
  });
});

describe("Connection tab › authentication", () => {
  it.each<[string, () => StudioServerView, Record<string, string>]>([
    [
      "none",
      () => studioView(SCRATCH),
      { [auth("mode")]: auth("modes.none"), [auth("credential")]: "—" },
    ],
    [
      "service",
      () => studioView(STRIPE),
      {
        [auth("mode")]: auth("modes.service"),
        [auth("scheme")]: "bearer",
        [auth("credential")]: "oxagen:credential/stripe-restricted",
      },
    ],
    [
      "operator-oauth",
      () => studioView(BILLING),
      {
        [auth("mode")]: auth("modes.operatorOauth"),
        [auth("scheme")]: "oauth2",
        [auth("credential")]: "oxagen:credential/billing-oauth",
      },
    ],
  ])("shows the %s mode with its scheme and credential reference", (_mode, view, values) => {
    renderTab(view());
    expect(termsOf("auth")).toEqual(Object.keys(values));
    for (const [label, value] of Object.entries(values)) {
      expect(fact("auth", label).textContent).toBe(value);
    }
  });

  it("offers an editor Replace credential, disabled until lane M8 lands and described by the vault note", () => {
    renderTab(studioView(STRIPE));
    const replace = screen.getByRole("button", { name: auth("replace") });
    expect(replace).toBeDisabled();
    expect(replace).toHaveAttribute("data-testid", "studio-credential-replace");
    expect(replace).toHaveAttribute("data-gap", CREDENTIALS_GAP);
    expect(replace).toHaveAccessibleDescription(auth("note"));
    // Stripe signs in with a static credential, so there is nothing to reconnect.
    expect(screen.queryByTestId(`provider-reconnect-${STRIPE}`)).toBeNull();
  });

  it("shows a reader neither Replace credential nor Reconnect, and still shows the vault note", () => {
    renderTab(studioView(GITHUB, null), {
      server: oauthServer(GITHUB, NEEDS_SIGN_IN),
      canEdit: false,
    });
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(within(section("auth")).getByText(auth("note"))).toBeVisible();
    expect(
      within(fact("auth", auth("mode"))).getByText(
        status("states.needs_reauth"),
      ),
    ).toBeVisible();
  });

  it("shows an OAuth provider that needs sign-in as red, with its expiry and a Reconnect", () => {
    renderTab(studioView(GITHUB, null), {
      server: oauthServer(GITHUB, NEEDS_SIGN_IN),
    });
    expect(fact("source", term("auth")).textContent).toBe(
      status("kinds.oauth"),
    );
    expect(light(GITHUB)).toHaveAttribute("data-light", "red");
    expect(light(GITHUB)).toHaveAttribute("data-reason", "needsReauth");
    expect(light(GITHUB)).toHaveTextContent(status("lights.red"));
    expect(light(GITHUB)).toHaveTextContent(status("short.needsReauth"));
    const mode = within(fact("auth", auth("mode")));
    expect(mode.getByText(status("states.needs_reauth"))).toBeVisible();
    expect(
      mode.getByText(
        status("expires", { when: dateOf("2026-09-30T12:00:00.000Z") }),
      ),
    ).toBeVisible();
    expect(mode.getByText(status("notRefreshable"))).toBeVisible();
    const button = screen.getByRole("button", {
      name: reconnect("named", { name: "GitHub" }),
    });
    expect(button).toHaveAttribute("data-testid", `provider-reconnect-${GITHUB}`);
    expect(button).toHaveTextContent(reconnect("open"));
  });

  it("shows a signed-in OAuth provider as green, renewing on its own, with no expiry line", () => {
    renderTab(studioView(STRIPE, null), {
      server: oauthServer(STRIPE, SIGNED_IN),
    });
    expect(light(STRIPE)).toHaveAttribute("data-light", "green");
    expect(light(STRIPE)).toHaveAttribute("data-reason", "ok");
    const mode = fact("auth", auth("mode"));
    expect(within(mode).getByText(status("states.connected"))).toBeVisible();
    expect(within(mode).getByText(status("refreshable"))).toBeVisible();
    expect(mode).not.toHaveTextContent(status("expires", { when: "" }).trim());
    expect(
      screen.getByRole("button", {
        name: reconnect("named", { name: "Stripe" }),
      }),
    ).toBeVisible();
  });

  it("reconnects an OAuth provider in a popup for the page's workspace and re-reads the page", async () => {
    const popup = stubPopup();
    try {
      startProviderAuthorization.mockResolvedValue({
        ok: true,
        value: {
          status: "authorized",
          serverId: GITHUB,
          healthStatus: "healthy",
          discoveredTools: [],
        },
      });
      renderTab(studioView(GITHUB, null), {
        server: oauthServer(GITHUB, NEEDS_SIGN_IN),
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: reconnect("named", { name: "GitHub" }),
        }),
      );
      await waitFor(() => {
        expect(router.refresh).toHaveBeenCalledTimes(1);
      });
      expect(startProviderAuthorization).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { mode: "reconnect", serverId: GITHUB },
      );
      expect(popup.open).toHaveBeenCalled();
      expect(popup.close).toHaveBeenCalled();
    } finally {
      popup.open.mockRestore();
      popup.remove();
    }
  });
});

describe("Connection tab › sync", () => {
  it.each<[string, () => StudioServerView, string, string]>([
    [
      "Stripe",
      () => studioView(STRIPE),
      sync("schedules.onChange"),
      lastSyncOf(stripeRecord()),
    ],
    [
      "Billing",
      () => studioView(BILLING),
      sync("schedules.daily"),
      lastSyncOf(billingRecord()),
    ],
    [
      "Scratch",
      () => studioView(SCRATCH),
      sync("schedules.manual"),
      sync("never"),
    ],
  ])("shows the schedule and last sync of %s", (_server, view, schedule, last) => {
    renderTab(view());
    expect(fact("sync", sync("schedule")).textContent).toBe(schedule);
    expect(plain(fact("sync", sync("lastAt")).textContent)).toBe(last);
  });
});

describe("Connection tab › credentials", () => {
  it.each<[string, () => StudioServerView, string[]]>([
    [
      "Stripe",
      () => studioView(STRIPE),
      ["oxagen:credential/stripe-restricted"],
    ],
    [
      "Billing",
      () => studioView(BILLING),
      [
        "oxagen:credential/billing-sandbox",
        "oxagen:credential/billing-production",
        "oxagen:credential/billing-oauth",
      ],
    ],
    ["Scratch", () => studioView(SCRATCH), []],
    [
      "Warehouse",
      () => studioView(WAREHOUSE),
      ["oxagen:credential/warehouse-key"],
    ],
    ["GitHub before discovery", () => studioView(GITHUB, null), []],
    ["a registry package", () => studioView(GITHUB, packageRecord()), []],
    ["a local command", () => studioView(GITHUB, localRecord()), []],
  ])("shows credentials only as vault references for %s", (_server, view, references) => {
    renderTab(view());
    const texts = textsOf(document.body);
    const shown = texts.filter((text) => text.includes("credential/"));
    for (const text of shown) {
      expect(text).toMatch(REFERENCE);
    }
    expect(new Set(shown)).toEqual(new Set(references));
    for (const value of credentialValues()) {
      expect(value.textContent).toMatch(CREDENTIAL_SHOWN);
    }
    expect(texts.filter((text) => SECRET.test(text))).toEqual([]);
    expect(
      attributesOf(document.body).filter((value) => SECRET.test(value)),
    ).toEqual([]);
  });

  it("hides a credential the record holds as raw text, on the server and on an environment", () => {
    // Built at run time so the repository's push protection does not read the
    // fixture as a live key. Each value still matches SECRET.
    const pasted = ["sk", "live", "51Hx9RawSecretPastedIntoToml"].join("_");
    const token = `Bearer ${["ghp", "abcdefghijklmnopqrstuv"].join("_")}`;
    const sandbox: StudioEnvironment = {
      name: "sandbox",
      sandbox: true,
      url: "https://billing.example.com/sandbox",
      network: null,
      credential: token,
    };
    const production: StudioEnvironment = {
      name: "production",
      sandbox: false,
      url: "https://billing.example.com",
      network: null,
      credential: null,
    };
    renderTab(
      studioView(BILLING, {
        ...billingRecord(),
        environments: [sandbox, production],
        auth: { mode: "service", scheme: "bearer", credential: pasted },
      }),
    );
    expect(document.body.textContent).not.toContain(pasted);
    expect(document.body.textContent).not.toContain("ghp_");
    expect(textsOf(document.body).filter((text) => SECRET.test(text))).toEqual(
      [],
    );
    const withheld = screen.getAllByTestId("studio-credential-withheld");
    expect(withheld).toHaveLength(3);
    for (const node of withheld) {
      expect(node).toHaveTextContent(connection("withheld"));
    }
    expect(
      within(cellOf("sandbox", "credential")).getByTestId(
        "studio-credential-withheld",
      ),
    ).toBeInTheDocument();
    expect(
      within(cellOf("production", "credential")).getByTestId(
        "studio-credential-withheld",
      ),
    ).toBeInTheDocument();
    expect(
      within(fact("auth", auth("credential"))).getByTestId(
        "studio-credential-withheld",
      ),
    ).toBeInTheDocument();
  });

  it("hides a vault reference with an empty name", () => {
    renderTab(
      studioView(STRIPE, {
        ...stripeRecord(),
        auth: {
          mode: "service",
          scheme: "bearer",
          credential: "oxagen:credential/",
        },
      }),
    );
    expect(
      within(fact("auth", auth("credential"))).getByTestId(
        "studio-credential-withheld",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("oxagen:credential/");
  });
});

describe("Connection tab › addresses", () => {
  // Each secret is built at run time so the repository's push protection does
  // not read the fixture as a live key.
  const KEY = ["sk", "live", "51HxAddressKeyInQuery"].join("_");
  const TOKEN = ["ghp", "abcdefghijklmnopqrstuv"].join("_");
  const PASSWORD = ["hunter2", "address", "pass"].join("-");

  /** One server's page, joined as the page joins it, with its row at `endpointUrl`. */
  function viewAt(
    serverId: string,
    endpointUrl: string,
    record: StudioRecord | null,
  ): StudioServerView {
    return buildStudioView({
      server: { ...studioServer(serverId), endpointUrl },
      versions: versionsOf(serverId).items,
      board: studioBoard(),
      record,
    });
  }

  /** No secret in any text or attribute, and the secrets above nowhere. */
  function expectNoSecret() {
    const text = document.body.textContent;
    for (const secret of [KEY, TOKEN, PASSWORD]) {
      expect(text).not.toContain(secret);
    }
    expect(textsOf(document.body).filter((node) => SECRET.test(node))).toEqual(
      [],
    );
    expect(
      attributesOf(document.body).filter((value) => SECRET.test(value)),
    ).toEqual([]);
  }

  it("hides a remote URL's user info and a key in its query, and keeps the other parameters", () => {
    const url = `https://billing:${PASSWORD}@mcp.stripe.example/v1?api_key=${KEY}&region=eu`;
    renderTab(
      viewAt(
        STRIPE,
        url,
        withSource(stripeRecord(), {
          type: "remote",
          url,
          transport: "http",
          network: null,
        }),
      ),
    );
    const shown = "https://***@mcp.stripe.example/v1?api_key=***&region=eu";
    expect(fact("source", term("url")).textContent).toBe(shown);
    expect(cellOf("default", "url").textContent).toBe(shown);
    expectNoSecret();
  });

  it("hides a value whose parameter name is percent-encoded, and keeps a malformed escape readable", () => {
    // The recipient reads %74oken as token, so it is hidden like one. %zz is
    // not a valid escape: decodeURIComponent throws, and the name as written
    // is the only reading there is, so region stays visible.
    const sandbox: StudioEnvironment = {
      name: "sandbox",
      sandbox: true,
      url: `https://billing.example.com/mcp?%74oken=${TOKEN}&%zzregion=eu`,
      network: null,
      credential: null,
    };
    renderTab(
      studioView(BILLING, {
        ...billingRecord(),
        environments: [sandbox],
      }),
    );
    expect(cellOf("sandbox", "url").textContent).toBe(
      "https://billing.example.com/mcp?%74oken=***&%zzregion=eu",
    );
    expectNoSecret();
  });

  it("hides a token in an environment URL's fragment and a signature in its query", () => {
    const sandbox: StudioEnvironment = {
      name: "sandbox",
      sandbox: true,
      url: `https://billing.example.com/sandbox#access_token=${TOKEN}&expires_in=3600`,
      network: null,
      credential: null,
    };
    const production: StudioEnvironment = {
      name: "production",
      sandbox: false,
      url: `https://billing.example.com/mcp?sig=${KEY};page=2`,
      network: null,
      credential: null,
    };
    renderTab(
      studioView(BILLING, {
        ...billingRecord(),
        environments: [sandbox, production],
      }),
    );
    expect(cellOf("sandbox", "url").textContent).toBe(
      "https://billing.example.com/sandbox#access_token=***&expires_in=3600",
    );
    expect(cellOf("production", "url").textContent).toBe(
      "https://billing.example.com/mcp?sig=***;page=2",
    );
    expectNoSecret();
  });

  it("hides the user info and token of the registry row's endpoint before discovery records the server", () => {
    renderTab(
      viewAt(
        GITHUB,
        `https://bot:${TOKEN}@mcp.github.example/sse?token=${TOKEN}`,
        null,
      ),
    );
    const shown = "https://***@mcp.github.example/sse?token=***";
    expect(fact("source", term("endpoint")).textContent).toBe(shown);
    expect(cellOf("default", "url").textContent).toBe(shown);
    expectNoSecret();
  });

  it("hides a token in a URL a local command passes as an argument", () => {
    renderTab(
      studioView(
        GITHUB,
        withSource(localRecord(), {
          type: "local",
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            `https://mcp.acme.example/sse?auth_token=${TOKEN}`,
          ],
          env: [],
          machines: ["build-agents"],
        }),
      ),
    );
    expect(fact("source", term("command")).textContent).toBe(
      "npx -y mcp-remote https://mcp.acme.example/sse?auth_token=***",
    );
    expectNoSecret();
  });

  it("hides the user info of a definition's repository and a key in its URL", () => {
    renderTab(
      studioView(
        BILLING,
        withSource(billingRecord(), {
          type: "openapi",
          from: "repository",
          repo: `https://deploy:${PASSWORD}@github.com/acme/billing-api`,
          path: "openapi/billing.yaml",
          ref: "main",
          url: `https://billing.internal.example/openapi.json?key=${KEY}`,
          network: null,
        }),
      ),
    );
    expect(fact("source", term("repo")).textContent).toBe(
      "https://***@github.com/acme/billing-api",
    );
    expect(fact("source", term("url")).textContent).toBe(
      "https://billing.internal.example/openapi.json?key=***",
    );
    expectNoSecret();
  });
});
