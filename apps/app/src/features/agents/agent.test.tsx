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
import {
  agentDetail,
  agentsSource,
  committedDefinition,
  incident,
  incidentPage,
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

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function renderAgent(
  reads: Parameters<typeof agentsSource>[0],
  tab: string | null = null,
  cursor: string | null = null,
) {
  const { source, calls } = agentsSource(reads);
  const element = await Agent({
    ctx,
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
    ).toEqual(["Rotate credential", "Suspend", "Deregister"]);
    expect(
      within(header).getByRole("link", {
        name: "See the belt as the model sees it",
      }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot?tab=toolbelt",
    );
  });

  it("links the six sections a store backs, and no Budgets or Runs tab (negative)", async () => {
    await renderAgent({ get: readOk(agentDetail()) });
    const links = within(
      screen.getByRole("navigation", { name: "Agent sections" }),
    ).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Identity", "/acme/core-platform/agents/release-bot?tab=identity"],
      ["Toolbelt", "/acme/core-platform/agents/release-bot?tab=toolbelt"],
      ["Enrollment", "/acme/core-platform/agents/release-bot?tab=enrollment"],
      [
        "Tamper incidents",
        "/acme/core-platform/agents/release-bot?tab=incidents",
      ],
      [
        "Definition in git",
        "/acme/core-platform/agents/release-bot?tab=definition",
      ],
      ["Mandates", "/acme/core-platform/agents/release-bot?tab=mandates"],
    ]);
    expect(document.body).not.toHaveTextContent(/budget|trust|score/i);
  });

  it("offers Resume for a suspended agent and no write at all for a retired one", async () => {
    await renderAgent({
      get: readOk(agentDetail({ identity: { status: "suspended" } })),
    });
    expect(
      within(region("Agent identity"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Rotate credential", "Resume", "Deregister"]);
    cleanup();

    await renderAgent({
      get: readOk(agentDetail({ identity: { status: "retired" } })),
    });
    expect(within(region("Agent identity")).queryAllByRole("button")).toEqual(
      [],
    );
  });

  it("opens Identity for an unknown tab (negative)", async () => {
    const calls = await renderAgent({ get: readOk(agentDetail()) }, "budgets");
    expect(current()).toEqual(["Identity"]);
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

describe("Identity", () => {
  it("draws the principal, its roles and its credentials, and reads nothing else", async () => {
    const calls = await renderAgent({ get: readOk(agentDetail()) });
    expect(current()).toEqual(["Identity"]);
    const identity = region("Identity");
    expect(identity).toHaveTextContent("Principalprn_91");
    expect(identity).toHaveTextContent("Operatorusr_marcusbell");
    expect(
      within(region("Roles"))
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["CI writer", "workspace", "Sep 2, 2026, 10:00 AM", "standing"]);
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
    expect(region("Roles")).toHaveTextContent(
      "No role is assigned: the agent reaches nothing but its own run channel.",
    );
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
    expect(current()).toEqual(["Enrollment"]);
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
    ]);
    expect(calls.toolbelt).toEqual([]);
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
    expect(empty).toHaveTextContent("oxagen tacho enroll");
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
      [
        "Newest incidents",
        "/acme/core-platform/agents/release-bot?tab=incidents",
      ],
      [
        "Older incidents",
        "/acme/core-platform/agents/release-bot?tab=incidents&cursor=c4",
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

describe("Definition in git", () => {
  it("draws the committed file's fields and the commit it came from, with the editor one link away", async () => {
    await renderAgent(
      { get: readOk(agentDetail({ definition: committedDefinition() })) },
      "definition",
    );
    expect(current()).toEqual(["Definition in git"]);
    const file = region("The file");
    expect(file).toHaveTextContent("Schemaagent-definition/v0.1");
    expect(file).toHaveTextContent("Model tiercomplex");
    expect(file).toHaveTextContent("Per-run budget$2.50");
    expect(file).toHaveTextContent("Toolsgithub__*linear__get_issue");
    expect(file).toHaveTextContent("Descriptionnot set");
    expect(file).toHaveTextContent("Denied toolsnot set");
    expect(file).toHaveTextContent("Harnessclaude-code");
    expect(file).toHaveTextContent("InstructionsYou prepare releases.");
    const source = region("Source");
    expect(source).toHaveTextContent("Branchagents/release-bot");
    expect(source).toHaveTextContent("Commit9c1e2f0");
    expect(source).toHaveTextContent(
      "Pull requesthttps://github.com/acme/core/pull/12",
    );
    expect(
      within(source).getByRole("link", { name: "Open in the source editor" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents/release-bot/source");
  });

  it("names the line a committed file does not parse at", async () => {
    await renderAgent(
      {
        get: readOk(
          agentDetail({
            definition: committedDefinition(
              'slug = "release-bot"\nname = open\n',
            ),
          }),
        ),
      },
      "definition",
    );
    expect(screen.getByTestId("definition-unparsed")).toHaveTextContent(
      "The committed file does not parse at line 2.",
    );
  });

  it("points an agent with no committed file at the editor", async () => {
    await renderAgent({ get: readOk(agentDetail()) }, "definition");
    const none = region("No definition committed");
    expect(none).toHaveTextContent(".oxagen/agents/release-bot.toml");
    expect(
      within(none).getByRole("link", { name: "Open in the source editor" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents/release-bot/source");
  });
});
