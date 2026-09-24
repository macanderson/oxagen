// @vitest-environment jsdom
// One agent over a fake DataSource: the header and each of the five sections
// in its ok, empty, denied and error states, with an axe check in every one.
// Only the chosen section makes its own read; an unknown agent is a 404. The
// Mandates section has its own file, mandates.test.tsx.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  agentDetail,
  agentsSource,
  committedDefinition,
  incident,
  incidentPage,
  spendBudgets,
  toolbelt,
} from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Agent } = await import("./agent");

// The fields, kept apart from the minted viewer: a test that wants the same
// viewer in another org role mints a second one from these rather than
// spreading the first, which is a class instance and not a plain object.
const CTX_FIELDS = {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
} as const;

const ctx = unsafeMint(WsCtx, CTX_FIELDS);

async function renderAgent(
  reads: Parameters<typeof agentsSource>[0],
  tab: string | null = "identity",
  cursor: string | null = null,
  /** The viewer, for the cases that turn on the organization role it holds. */
  viewer = ctx,
) {
  const { source, calls } = agentsSource(
    tab === "permissions" || tab === "budgets" || tab === "mandates"
      ? { budgets: readOk([]), mandates: mandateList([]), ...reads }
      : reads,
  );
  const element = await Agent({
    ctx: viewer,
    source,
    agent: "release-bot",
    tab,
    cursor,
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

/** A fixed instant the expiry-boundary tests move the clock across. */
const CLOCK_NOW = Date.parse("2026-09-16T12:00:00.000Z");

const region = (name: string) => screen.getByRole("region", { name });
const current = () =>
  within(screen.getByRole("navigation", { name: "Agent sections" }))
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Agent header and tabs", () => {
  it("reads the agent the URL names and draws its card, status, harness, description and writes", async () => {
    const calls = await renderAgent({ get: readOk(agentDetail()) });
    expect(calls.get).toEqual([[ctx, "release-bot"]]);
    const header = region("Agent identity");
    expect(header).toHaveTextContent("acme.core.release-bot");
    expect(header).toHaveTextContent("Release bot");
    expect(header).toHaveTextContent("enrolled");
    expect(header).toHaveTextContent("Claude Code");
    expect(header).toHaveTextContent(
      "Cuts releases and opens their pull requests.",
    );
    expect(
      within(header)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Clone",
      "Kill switch",
      "Rotate credential",
      "Suspend",
      "Deregister",
    ]);
    // The Toolbelt tab is the one way to the belt; the header carries no second link to it.
    expect(within(header).queryByRole("link")).toBeNull();
  });

  it("draws the kill switch disabled with its reason for an organization Member (negative)", async () => {
    await renderAgent(
      { get: readOk(agentDetail()) },
      null,
      null,
      unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole: "member" }),
    );
    const header = region("Agent identity");
    expect(
      within(header).getByRole("button", { name: "Kill switch" }),
    ).toBeDisabled();
    expect(
      within(header).getByTestId("agent-kill-switch-no-role"),
    ).toHaveTextContent("Owner or Admin");
  });

  it("links the eight canonical sections and defaults to Overview", async () => {
    await renderAgent({ get: readOk(agentDetail()) }, null);
    const links = within(
      screen.getByRole("navigation", { name: "Agent sections" }),
    ).getAllByRole("link");
    expect(
      links.map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual(
      [
        "Overview",
        "Identity",
        "Steering",
        "Toolbelt",
        "Runtime",
        "Permissions",
        "Activity",
        "Definition",
      ].map((label) => [
        label,
        `/acme/core-platform/agents/release-bot/${label.toLowerCase()}`,
      ]),
    );
    expect(current()).toEqual(["Overview"]);
    expect(region("Composition")).toHaveTextContent("prn_91");
  });

  it("reads ceilings and mandates together on Permissions", async () => {
    const calls = await renderAgent(
      { get: readOk(agentDetail()), budgets: readOk(spendBudgets()) },
      "budgets",
    );
    expect(current()).toEqual(["Permissions"]);
    const panel = region("Budgets");
    expect(
      within(panel).getByRole("row", { name: /This workspace/ }),
    ).toHaveTextContent("$500.00");
    expect(
      within(panel).getByTestId("agent-budget-not-backed"),
    ).toHaveTextContent("Oxagen records no ceiling for one agent");
    expect(
      within(panel).getByRole("link", { name: "Set ceilings on Spend" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend/budgets");
    expect(calls.budgets).toHaveLength(1);
    expect(calls.toolbelt).toEqual([]);
    expect(calls.incidents).toEqual([]);
  });

  it("keeps the agent-scope line when no ceiling is set at all (negative)", async () => {
    await renderAgent(
      { get: readOk(agentDetail()), budgets: readOk([]) },
      "budgets",
    );
    expect(screen.getByTestId("budgets-empty")).toHaveTextContent(
      "No spend ceiling is set",
    );
    expect(screen.getByTestId("agent-budget-not-backed")).toBeInTheDocument();
  });

  it("renders a refused budgets read in place of the table (negative)", async () => {
    await renderAgent(
      {
        get: readOk(agentDetail()),
        budgets: readError("rollup_rebuild_in_progress", 504),
      },
      "budgets",
    );
    expect(region("Budgets")).toHaveTextContent("rollup_rebuild_in_progress");
    expect(
      within(region("Budgets")).queryByRole("table"),
    ).not.toBeInTheDocument();
  });

  it("offers Resume for a suspended agent and Clone alone for a retired one", async () => {
    await renderAgent({
      get: readOk(agentDetail({ identity: { status: "suspended" } })),
    });
    expect(
      within(region("Agent identity"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Clone",
      "Kill switch",
      "Rotate credential",
      "Resume",
      "Deregister",
    ]);
    cleanup();

    await renderAgent({
      get: readOk(agentDetail({ identity: { status: "retired" } })),
    });
    // Clone reads the retired configuration and writes a new draft under a new
    // identity; it changes nothing about the retired record (ADR-136). Every
    // control that would write to the retired agent itself stays gone.
    expect(
      within(region("Agent identity"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Clone"]);
  });

  it("opens Overview for an unknown tab (negative)", async () => {
    const calls = await renderAgent(
      { get: readOk(agentDetail()) },
      "not-a-tab",
    );
    expect(current()).toEqual(["Overview"]);
    expect(calls.toolbelt).toEqual([]);
    expect(calls.incidents).toEqual([]);
  });

  it("is a 404 for an agent the workspace does not have (negative)", async () => {
    const { source } = agentsSource({ get: readError("not_found", 404) });
    await expect(
      Agent({ ctx, source, agent: "nobody", tab: null, cursor: null }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    [
      { ok: false, reason: "denied", permission: "agent.read" } as const,
      "You cannot see release-bot in this workspace. Your roles do not include agent.read",
    ],
    [
      readError("iam_principals_unavailable", 503),
      "release-bot could not be loaded: the control plane answered iam_principals_unavailable.",
    ],
  ])(
    "draws a refused agent read in place of the page (negative)",
    async (read, text) => {
      await renderAgent({ get: read });
      expect(document.body).toHaveTextContent(text);
      expect(screen.queryByRole("navigation")).toBeNull();
    },
  );
});

describe("Permissions", () => {
  it("keeps role assignment and mandate and budget panels together", async () => {
    const calls = await renderAgent(
      {
        get: readOk(agentDetail()),
        budgets: readOk(spendBudgets()),
        mandates: mandateList([]),
      },
      "permissions",
    );
    expect(current()).toEqual(["Permissions"]);
    expect(
      within(region("Roles")).getByRole("button", { name: "Assign a role" }),
    ).toBeInTheDocument();
    expect(
      within(region("Roles")).getByRole("button", { name: "Revoke CI writer" }),
    ).toBeInTheDocument();
    expect(calls.budgets).toHaveLength(1);
    expect(calls.mandates).toHaveLength(1);
    expect(calls.toolbelt).toEqual([]);
  });
});

describe("Identity", () => {
  // set_cost_center admits an org Owner, Admin or Billing member (ADR-142),
  // so Billing sees the control the role writes deny it, and a Member sees
  // the label alone.
  it("draws the cost center and offers the change to a billing member", async () => {
    await renderAgent(
      { get: readOk(agentDetail({ identity: { costCenter: "ENG-1001" } })) },
      "identity",
      null,
      unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole: "billing" }),
    );
    const identity = region("Identity");
    expect(identity).toHaveTextContent("Cost centerENG-1001");
    expect(
      within(identity).getByRole("button", { name: "Change cost center" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Roles" })).toBeNull();
  });

  it("says the label is inherited and offers no change to a member (negative)", async () => {
    await renderAgent(
      { get: readOk(agentDetail()) },
      "identity",
      null,
      unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole: "member" }),
    );
    const identity = region("Identity");
    expect(identity).toHaveTextContent(
      "Cost centerInherited from the workspace",
    );
    expect(within(identity).queryAllByRole("button")).toEqual([]);
  });

  // assign_agent_role and revoke_agent_role are org Owner or Admin writes
  // their handlers check, and a retired principal holds no authority to
  // change, so the panel offers a control neither reader could use.
  it.each([
    ["a member", { detail: agentDetail(), role: "member" as const }],
    [
      "a retired identity",
      {
        detail: agentDetail({ identity: { status: "retired" } }),
        role: "owner" as const,
      },
    ],
  ])("offers no role control to %s (negative)", async (_name, at) => {
    await renderAgent(
      { get: readOk(at.detail) },
      "permissions",
      null,
      unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole: at.role }),
    );
    const roles = region("Roles");
    expect(within(roles).queryAllByRole("button")).toEqual([]);
    expect(
      within(roles)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Role", "Scope", "Assigned", "Expires"]);
  });

  it("draws the principal, its roles and its credentials, and reads nothing else", async () => {
    const calls = await renderAgent({ get: readOk(agentDetail()) });
    expect(current()).toEqual(["Identity"]);
    const identity = region("Identity");
    expect(identity).toHaveTextContent("Principalprn_91");
    expect(identity).toHaveTextContent("Operatorusr_marcusbell");
    expect(screen.queryByRole("region", { name: "Roles" })).toBeNull();
    expect(
      within(region("Run credentials"))
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "oxa_ag_7frelease-bot run key",
      "Sep 1, 2026, 10:00 AM",
      "never",
      "Mar 1, 2099, 10:00 AM",
      "active",
    ]);
    expect(calls.toolbelt).toEqual([]);
    expect(calls.incidents).toEqual([]);
  });

  it("reads 'not recorded' and the empty lines where nothing is held", async () => {
    await renderAgent({
      get: readOk(
        agentDetail({
          identity: { principalId: null, operatorId: null, firstFrameAt: null },
          roles: [],
          credentials: [],
        }),
      ),
    });
    const identity = region("Identity");
    expect(identity).toHaveTextContent("Principalnot recorded");
    expect(identity).toHaveTextContent("Operatornot recorded");
    expect(identity).toHaveTextContent("First frameno frame yet");
    expect(region("Run credentials")).toHaveTextContent(
      "The agent holds no long-lived credential.",
    );
  });

  it("marks a credential whose expiry has passed as expired, never active (negative)", async () => {
    // resolveApiKey refuses an expired key; a row reading "active" over it
    // would be the page disagreeing with the date in the cell beside it.
    const [credential] = agentDetail().credentials;
    await renderAgent({
      get: readOk(
        agentDetail({
          credentials: credential
            ? [{ ...credential, expiresAt: "2020-01-01T10:00:00.000Z" }]
            : [],
        }),
      ),
    });
    const row = screen.getByTestId("credential-row");
    expect(row.querySelector("[data-state]")).toHaveAttribute(
      "data-state",
      "expired",
    );
    expect(row).toHaveTextContent("expired");
    expect(row).not.toHaveTextContent("active");
  });

  it("turns a credential from active to expired when its expiry passes while the page is open", async () => {
    // `now` is captured once, server-side, so without a running clock this row
    // would go on claiming authority the resolver already refuses. The word
    // has to change, not merely the control beside it — there is no control
    // here, the word is the whole claim.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(CLOCK_NOW);
    const [credential] = agentDetail().credentials;
    await renderAgent({
      get: readOk(
        agentDetail({
          credentials: credential
            ? [
                {
                  ...credential,
                  expiresAt: new Date(CLOCK_NOW + 20_000).toISOString(),
                },
              ]
            : [],
        }),
      ),
    });
    const state = () =>
      screen.getByTestId("credential-row").querySelector("[data-state]");
    expect(state()).toHaveAttribute("data-state", "live");
    expect(screen.getByTestId("credential-row")).toHaveTextContent("active");

    await act(async () => {
      vi.setSystemTime(CLOCK_NOW + 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(state()).toHaveAttribute("data-state", "expired");
    const row = screen.getByTestId("credential-row");
    expect(row).toHaveTextContent("expired");
    expect(row).not.toHaveTextContent("active");
  });

  it("leaves a credential with no expiry active however long the page is open (negative)", async () => {
    // Nothing to cross, so the row sets no timer and nothing can change it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(CLOCK_NOW);
    const [credential] = agentDetail().credentials;
    await renderAgent({
      get: readOk(
        agentDetail({
          credentials: credential ? [{ ...credential, expiresAt: null }] : [],
        }),
      ),
    });
    await act(async () => {
      vi.setSystemTime(CLOCK_NOW + 86_400_000);
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(
      screen.getByTestId("credential-row").querySelector("[data-state]"),
    ).toHaveAttribute("data-state", "live");
  });

  it("marks a revoked credential with when it was revoked", async () => {
    const [credential] = agentDetail().credentials;
    await renderAgent({
      get: readOk(
        agentDetail({
          credentials: credential
            ? [{ ...credential, revokedAt: "2026-09-10T10:00:00.000Z" }]
            : [],
        }),
      ),
    });
    expect(region("Run credentials")).toHaveTextContent(
      "revoked Sep 10, 2026, 10:00 AM",
    );
  });

  it("names revocation on a credential that is both revoked and expired, as the resolver does (negative)", async () => {
    const [credential] = agentDetail().credentials;
    await renderAgent({
      get: readOk(
        agentDetail({
          credentials: credential
            ? [
                {
                  ...credential,
                  expiresAt: "2020-01-01T10:00:00.000Z",
                  revokedAt: "2026-09-10T10:00:00.000Z",
                },
              ]
            : [],
        }),
      ),
    });
    const row = screen.getByTestId("credential-row");
    expect(row.querySelector("[data-state]")).toHaveAttribute(
      "data-state",
      "revoked",
    );
    expect(row).not.toHaveTextContent("expired");
  });
});

describe("Toolbelt", () => {
  it("reads the belt by the agent's id and draws how it was computed, what the model receives and each decision", async () => {
    const calls = await renderAgent(
      { get: readOk(agentDetail()), toolbelt: readOk(toolbelt()) },
      "toolbelt",
    );
    expect(calls.toolbelt).toEqual([[ctx, "agt_releasebot"]]);
    expect(current()).toEqual(["Toolbelt"]);
    const computed = region("How this belt was computed");
    expect(computed).toHaveTextContent(
      "Delegation ceilingthe agent's grants intersected with yours",
    );
    expect(computed).toHaveTextContent("Role grants4");
    expect(computed).toHaveTextContent(
      "Deny generationorganization 2, workspace 0",
    );
    expect(computed).toHaveTextContent("Kill switches in scope1");
    expect(region("What the model receives")).toHaveTextContent(
      "Full beltEvery tool definition is in the request.A belt of up to 40 tools is sent in full.",
    );
    const rows = screen.getAllByTestId("belt-tool");
    expect(
      within(rows[0] ?? document.body)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "github__create_pull_requestmcp_github",
      "source control",
      "medium",
      "requires approval",
      "agent:7:role_grant",
      "writes",
    ]);
    expect(
      within(rows[1] ?? document.body)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "search_tools",
      "not recorded",
      "low",
      "allow",
      "human:8:default",
      "reads only",
    ]);
    expect(
      within(region("What this agent cannot see"))
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["delete_repository", "agent:3:deny"]);
  });

  it("names a searchable belt and the unprivileged ceiling", async () => {
    await renderAgent(
      {
        get: readOk(agentDetail()),
        toolbelt: readOk(
          toolbelt({
            computation: {
              humanCeiling: "sentinel",
              roleGrants: 0,
              denyGeneration: { org: 0, workspace: 0 },
              killSwitches: 0,
            },
            presentation: {
              mode: "searchable",
              limit: 40,
              sentToModel: "meta_tools",
            },
          }),
        ),
      },
      "toolbelt",
    );
    expect(region("How this belt was computed")).toHaveTextContent(
      "no person resolved, so the unprivileged ceiling",
    );
    expect(region("What the model receives")).toHaveTextContent(
      "Searchable beltThe request carries the search and load meta-tools",
    );
  });

  it("says so when the belt is empty and every tool is on it", async () => {
    await renderAgent(
      {
        get: readOk(agentDetail()),
        toolbelt: readOk(toolbelt({ tools: [], cannotSee: [] })),
      },
      "toolbelt",
    );
    expect(region("Per-tool decision rules")).toHaveTextContent(
      "The belt is empty: the model is shown no tool.",
    );
    expect(region("What this agent cannot see")).toHaveTextContent(
      "Every tool in the registry is on the belt.",
    );
  });

  it.each([
    [
      { ok: false, reason: "denied", permission: "agent.read" } as const,
      "You cannot see Toolbelt in this workspace.",
    ],
    [
      readError("control_plane_unavailable", 503),
      "Toolbelt could not be loaded: the control plane answered control_plane_unavailable.",
    ],
  ])(
    "draws a refused belt read under the header (negative)",
    async (read, text) => {
      await renderAgent(
        { get: readOk(agentDetail()), toolbelt: read },
        "toolbelt",
      );
      expect(region("Toolbelt")).toHaveTextContent(text);
      expect(region("Agent identity")).toBeInTheDocument();
    },
  );
});

describe("Enrollment", () => {
  it("draws each host with what its daemon reported, and 'not recorded' for what it has not", async () => {
    const [host] = agentDetail().hosts;
    const calls = await renderAgent(
      {
        get: readOk(
          agentDetail({
            hosts: host
              ? [
                  host,
                  {
                    ...host,
                    hostEnrollmentId: "tch_zyxwvutsrqponmlkjihgfe",
                    hostname: "laptop-7",
                    platform: "darwin",
                    status: "suspended",
                    collectorVersion: "0.9.1",
                    hooksOk: false,
                    bundleVersionServed: 12,
                    lastSeenAt: "2026-09-14T10:00:00.000Z",
                    revokedAt: "2026-09-14T11:00:00.000Z",
                  },
                ]
              : [],
          }),
        ),
      },
      "enrollment",
    );
    expect(current()).toEqual(["Runtime"]);
    const [first, second] = screen.getAllByTestId("host-row");
    expect(
      within(first ?? document.body)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "build-01linux",
      "active",
      "enforce",
      "not recorded",
      "not reported",
      "not recorded",
      "sha256:ab12cd34",
      "never",
      "Revoke",
    ]);
    expect(
      within(second ?? document.body)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "laptop-7darwin",
      "suspendedrevoked Sep 14, 2026, 11:00 AM",
      "enforce",
      "0.9.1",
      "removed",
      "version 12",
      "sha256:ab12cd34",
      "Sep 14, 2026, 10:00 AM",
      // A revoked host has nothing left to revoke.
      "",
    ]);
    expect(calls.toolbelt).toEqual([]);
  });

  it("offers Enroll a host on the tab, and none for a retired identity (negative)", async () => {
    await renderAgent({ get: readOk(agentDetail()) }, "enrollment");
    expect(screen.getByTestId("enroll-host")).toBeInTheDocument();
    cleanup();

    // A retired identity is archived, so create_enrollment_token selects it
    // out and the control would only ever answer agent_not_found.
    await renderAgent(
      { get: readOk(agentDetail({ identity: { status: "retired" } })) },
      "enrollment",
    );
    expect(screen.queryByTestId("enroll-host")).not.toBeInTheDocument();
  });

  it("says an enrollment past its expiry has expired, over the status column alone (negative)", async () => {
    // tacho-host.ts refuses a host whose enrollment has expired, and the table
    // prints no expiry column, so the stored status is all a person would see.
    const [host] = agentDetail().hosts;
    await renderAgent(
      {
        get: readOk(
          agentDetail({
            hosts: host
              ? [{ ...host, expiresAt: "2020-01-01T10:00:00.000Z" }]
              : [],
          }),
        ),
      },
      "enrollment",
    );
    const row = screen.getByTestId("host-row");
    expect(row.querySelector("[data-state]")).toHaveAttribute(
      "data-state",
      "expired",
    );
    expect(row).toHaveTextContent("expired Jan 1, 2020, 10:00 AM");
  });

  it("turns an enrollment expired when its expiry passes while the page is open", async () => {
    // The table prints no expiry column, so without a running clock the stored
    // status word is the only thing a person sees — over a host whose every
    // request tacho-host.ts already refuses.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(CLOCK_NOW);
    const [host] = agentDetail().hosts;
    const expiresAt = new Date(CLOCK_NOW + 20_000).toISOString();
    await renderAgent(
      {
        get: readOk(
          agentDetail({ hosts: host ? [{ ...host, expiresAt }] : [] }),
        ),
      },
      "enrollment",
    );
    const state = () =>
      screen.getByTestId("host-row").querySelector("[data-state]");
    expect(state()).toHaveAttribute("data-state", "live");
    expect(screen.getByTestId("host-row")).not.toHaveTextContent("expired");

    await act(async () => {
      vi.setSystemTime(CLOCK_NOW + 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
    });

    // The expired state is a state with copy of its own, not the active one
    // going quiet: the row names it and prints the instant it ended.
    expect(state()).toHaveAttribute("data-state", "expired");
    expect(screen.getByTestId("host-row")).toHaveTextContent("expired");
  });

  it("names revocation on an enrollment that is both revoked and expired (negative)", async () => {
    const [host] = agentDetail().hosts;
    await renderAgent(
      {
        get: readOk(
          agentDetail({
            hosts: host
              ? [
                  {
                    ...host,
                    expiresAt: "2020-01-01T10:00:00.000Z",
                    revokedAt: "2026-09-14T11:00:00.000Z",
                  },
                ]
              : [],
          }),
        ),
      },
      "enrollment",
    );
    const row = screen.getByTestId("host-row");
    expect(row.querySelector("[data-state]")).toHaveAttribute(
      "data-state",
      "revoked",
    );
    expect(row).toHaveTextContent("revoked Sep 14, 2026, 11:00 AM");
    expect(row).not.toHaveTextContent("expired");
  });

  it("tells a person how to enroll a host when none is", async () => {
    await renderAgent(
      { get: readOk(agentDetail({ hosts: [] })) },
      "enrollment",
    );
    const empty = screen.getByTestId("hosts-empty");
    expect(empty).toHaveTextContent("No host is enrolled under this agent");
    expect(empty).toHaveTextContent("oxagen agent enroll");
    // The command needs the CLI, and the app is what installs it.
    expect(
      within(empty).getByRole("link", { name: ".deb (Debian, Ubuntu)" }),
    ).toHaveAttribute(
      "href",
      "https://downloads.oxagen.sh/latest/Oxagen_amd64.deb",
    );
  });
});

describe("Tamper incidents", () => {
  it("reads the agent's incidents at the URL's cursor and draws each one", async () => {
    const calls = await renderAgent(
      {
        get: readOk(agentDetail()),
        incidents: incidentPage(
          [
            incident(),
            incident({
              id: "tin_2",
              kind: "telemetry_gap",
              severity: "warning",
              detectedBy: "control_plane",
              sessionId: "tse_4f0a",
              resolvedAt: "2026-09-14T12:00:00.000Z",
              resolutionNote: "the daemon restarted",
            }),
          ],
          "c4",
        ),
      },
      "incidents",
      "c3",
    );
    expect(calls.incidents).toEqual([
      [ctx, "agt_releasebot", { cursor: "c3" }],
    ]);
    const [first, second] = screen.getAllByTestId("incident-row");
    expect(
      within(first ?? document.body)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "hooks_removed",
      "tamper",
      "Sep 14, 2026, 10:00 AMby the collector",
      "not recorded",
      "open",
    ]);
    expect(
      within(second ?? document.body)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "telemetry_gap",
      "warning",
      "Sep 14, 2026, 10:00 AMby the control plane",
      "tse_4f0a",
      "resolved Sep 14, 2026, 12:00 PMthe daemon restarted",
    ]);
    const pager = screen.getByRole("navigation", { name: "Incident pages" });
    expect(
      within(pager)
        .getAllByRole("link")
        .map((l) => [l.textContent, l.getAttribute("href")]),
    ).toEqual([
      ["Newest incidents", "/acme/core-platform/agents/release-bot/activity"],
      [
        "Older incidents",
        "/acme/core-platform/agents/release-bot/activity?cursor=c4",
      ],
    ]);
  });

  it("says no incident is recorded on the first page of none", async () => {
    await renderAgent(
      { get: readOk(agentDetail()), incidents: incidentPage([]) },
      "incidents",
    );
    expect(region("Tamper incidents")).toHaveTextContent(
      "No incident is recorded on this agent's hosts.",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("draws a refused incidents read (negative)", async () => {
    await renderAgent(
      {
        get: readOk(agentDetail()),
        incidents: readError("iam_principals_unavailable", 503),
      },
      "incidents",
    );
    expect(region("Tamper incidents")).toHaveTextContent(
      "Tamper incidents could not be loaded: the control plane answered iam_principals_unavailable.",
    );
  });
});

describe("Configuration", () => {
  it("draws the committed file as a form, its commit beside it, and the editor one link away", async () => {
    await renderAgent(
      {
        get: readOk(agentDetail({ definition: committedDefinition() })),
        mandates: mandateList([mandateRow()]),
      },
      "definition",
    );
    expect(current()).toEqual(["Definition"]);
    const identity = region("Identity");
    expect(screen.getByRole("textbox", { name: "Schema" })).toHaveValue(
      "agent-definition/v0.1",
    );
    expect(within(identity).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Release bot",
    );
    expect(screen.getByRole("combobox", { name: "Model tier" })).toHaveValue(
      "complex",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Per-run budget (USD)" }),
    ).toHaveValue(2.5);
    const tools = region("Tools");
    expect(
      within(tools)
        .getAllByRole("button", { name: /^Remove / })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Remove github__*", "Remove linear__get_issue"]);
    expect(
      within(tools).getByRole("checkbox", { name: /^irreversible/ }),
    ).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "You prepare releases.\n",
    );
    expect(screen.getByRole("textbox", { name: "Harness" })).toHaveValue(
      "claude-code",
    );
    expect(screen.getByRole("combobox", { name: "Color" })).toHaveValue("blue");
    const source = region("Source");
    expect(source).toHaveTextContent("Branchagents/release-bot");
    expect(source).toHaveTextContent("At commit9c1e2f0");
    expect(source).toHaveTextContent(
      "Pull requesthttps://github.com/acme/core/pull/12",
    );
    expect(
      within(source).getByRole("link", {
        name: /\.oxagen\/agents\/release-bot\.toml/,
      }),
    ).toHaveAttribute("href", "/acme/core-platform/agents/release-bot/source");
    expect(screen.queryByTestId("definition-dirty")).toBeNull();
  });

  it("names the line a committed file does not parse at and locks the form", async () => {
    await renderAgent(
      {
        get: readOk(
          agentDetail({
            definition: committedDefinition(
              'slug = "release-bot"\nname = open\n',
            ),
          }),
        ),
        mandates: mandateList([]),
      },
      "definition",
    );
    expect(screen.getByTestId("definition-unparsed")).toHaveTextContent(
      "The file does not parse at line 2",
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  });

  it("locks irreversible when the agent's only mandate is not in effect (negative)", async () => {
    await renderAgent(
      {
        get: readOk(agentDetail({ definition: committedDefinition() })),
        mandates: mandateList([mandateRow({ status: "revoked" })]),
      },
      "definition",
    );
    const locked = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(locked).toBeDisabled();
    expect(locked.closest("label")).toHaveTextContent("This agent holds none.");
  });

  it("seeds a form for an agent with no committed file and locks irreversible without a mandate", async () => {
    await renderAgent(
      { get: readOk(agentDetail()), mandates: mandateList([]) },
      "definition",
    );
    expect(screen.getByRole("textbox", { name: "Slug" })).toHaveValue(
      "release-bot",
    );
    expect(region("Source")).toHaveTextContent(
      "No definition is committed yet",
    );
    expect(
      screen.getByRole("checkbox", { name: /^irreversible/ }),
    ).toBeDisabled();
  });
});
