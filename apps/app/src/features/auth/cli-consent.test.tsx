// @vitest-environment jsdom
// The CLI consent page's reads through the pretenant port, and the picker in
// each state an action can leave it in.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { approveCliAuth, cancelCliAuth } = vi.hoisted(() => ({
  approveCliAuth: vi.fn(),
  cancelCliAuth: vi.fn(),
}));
vi.mock("./cli-actions", () => ({ approveCliAuth, cancelCliAuth }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { PretenantCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { loadConsentChoices } = await import("./cli-consent");
const { CliConsentForm } = await import("./cli-consent-form");

const ctx = unsafeMint(PretenantCtx, { userId: "u1" });

const orgs = vi.fn();
const workspaces = vi.fn();
const source = {
  runtimes: { list: vi.fn(), agents: vi.fn() },
  conversations: { latest: vi.fn() },
  pretenant: { orgs, workspaces },
  shell: {
    context: vi.fn(),
    preferences: vi.fn(),
    counts: vi.fn(),
    notifications: vi.fn(),
    assistantEngine: vi.fn(),
  },
  billing: {
    plan: vi.fn(),
    usageCredits: vi.fn(),
    retention: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: {
    list: vi.fn(),
    get: vi.fn(),
    frameBody: vi.fn(),
    cost: vi.fn(),
    turns: vi.fn(),
    transcript: vi.fn(),
    chain: vi.fn(),
    outputs: vi.fn(),
    work: vi.fn(),
    outcomesSettings: vi.fn(),
  },
  approvals: { pending: vi.fn(), resolved: vi.fn(), resolvedSince: vi.fn() },
  interjections: { open: vi.fn() },
  agents: {
    list: vi.fn(),
    get: vi.fn(),
    toolbelt: vi.fn(),
    incidents: vi.fn(),
  },
  spend: {
    byGroup: vi.fn(),
    fleet: vi.fn(),
    drill: vi.fn(),
    waste: vi.fn(),
    gatewayPolicy: vi.fn(),
    budgets: vi.fn(),
    findings: vi.fn(),
    findingEvidence: vi.fn(),
    priceBook: vi.fn(),
    unpricedModels: vi.fn(),
  },
  onboarding: { state: vi.fn(), firstFrame: vi.fn() },
  org: {
    members: vi.fn(),
    roles: vi.fn(),
    workspaces: vi.fn(),
    apiKeys: vi.fn(),
    costCenters: vi.fn(),
    modelCredential: vi.fn(),
    dataPlane: vi.fn(),
    workspaceFacts: vi.fn(),
    sso: vi.fn(),
  },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: {
    events: vi.fn(),
    exportEvents: vi.fn(),
    retention: vi.fn(),
    bundle: vi.fn(),
  },
  skills: { inventory: vi.fn(), configuration: vi.fn() },
  steering: {
    records: vi.fn(),
    record: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
    hub: vi.fn(),
    deliveries: vi.fn(),
    memories: vi.fn(),
    tree: vi.fn(),
  },
  tools: {
    versions: vi.fn(),
    grants: vi.fn(),
    killSwitches: vi.fn(),
    approvalRules: vi.fn(),
    connections: vi.fn(),
    mcpServers: vi.fn(),
  },
};

beforeEach(() => {
  orgs.mockReset();
  workspaces.mockReset();
  approveCliAuth.mockReset();
  cancelCliAuth.mockReset();
});
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("loadConsentChoices", () => {
  it("pairs each organization with the workspaces the person is a member of, leaving out one with none", async () => {
    orgs.mockResolvedValue(
      readOk([
        { slug: "acme", name: "Acme" },
        { slug: "empty", name: "Empty" },
      ]),
    );
    workspaces.mockImplementation((_ctx: unknown, slug: string) =>
      Promise.resolve(
        readOk(slug === "acme" ? [{ slug: "core", name: "Core" }] : []),
      ),
    );
    expect(await loadConsentChoices(ctx, source)).toEqual(
      readOk([
        {
          slug: "acme",
          name: "Acme",
          workspaces: [{ slug: "core", name: "Core" }],
        },
      ]),
    );
    expect(orgs).toHaveBeenCalledWith(ctx);
    expect(workspaces).toHaveBeenCalledWith(ctx, "acme");
    expect(workspaces).toHaveBeenCalledWith(ctx, "empty");
  });

  it("answers a refused organizations read, reading no workspaces (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    orgs.mockResolvedValue(down);
    expect(await loadConsentChoices(ctx, source)).toEqual(down);
    expect(workspaces).not.toHaveBeenCalled();
  });

  it("answers a denied workspaces read (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.read" };
    orgs.mockResolvedValue(readOk([{ slug: "acme", name: "Acme" }]));
    workspaces.mockResolvedValue(denied);
    expect(await loadConsentChoices(ctx, source)).toEqual(denied);
  });
});

describe("CliConsentForm", () => {
  const params = {
    redirectUri: "http://127.0.0.1:53682/callback",
    state: "st_1",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    codeChallengeMethod: "S256",
    label: "laptop",
  };
  const choices = [
    {
      slug: "acme",
      name: "Acme",
      workspaces: [{ slug: "core", name: "core" }],
    },
    {
      slug: "globex",
      name: "Globex",
      workspaces: [
        { slug: "labs", name: "labs" },
        { slug: "ops", name: "ops" },
      ],
    },
  ];

  function renderForm() {
    render(
      <IntlProvider>
        <CliConsentForm params={params} orgs={choices} />
      </IntlProvider>,
    );
  }

  it("picks an organization and its first workspace, carrying every parameter as a hidden field", async () => {
    renderForm();
    expect(screen.getByLabelText("Workspace")).toHaveValue("core");
    await userEvent.selectOptions(
      screen.getByLabelText("Organization"),
      "globex",
    );
    expect(screen.getByLabelText("Workspace")).toHaveValue("labs");
    await userEvent.selectOptions(screen.getByLabelText("Workspace"), "ops");
    expect(screen.getByLabelText("Workspace")).toHaveValue("ops");
    expect(
      document.querySelectorAll('input[type="hidden"][name="code_challenge"]'),
    ).toHaveLength(2);
    expect(screen.queryByTestId("cli-error")).toBeNull();
  });

  it.each([
    [
      "denied",
      { ok: false, reason: "denied", code: "forbidden" },
      "needs permission to create API keys",
    ],
    [
      "not found",
      { ok: false, reason: "not_found", code: "workspace_not_found" },
      "no longer exists",
    ],
    [
      "invalid",
      { ok: false, reason: "invalid", code: "invalid_input", field: "state" },
      "Run the CLI login command again",
    ],
    [
      "unavailable",
      { ok: false, reason: "unavailable", code: "kernel_failure" },
      "could not be authorized",
    ],
  ])(
    "says why an approval was refused: %s (negative)",
    async (_label, result, copy) => {
      approveCliAuth.mockResolvedValue(result);
      renderForm();
      await userEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(await screen.findByTestId("cli-error")).toHaveTextContent(copy);
    },
  );

  it("says why a cancel was refused (negative)", async () => {
    cancelCliAuth.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "redirectUri",
    });
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByTestId("cli-error")).toHaveTextContent(
      "Run the CLI login command again",
    );
  });
});
