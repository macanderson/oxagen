// @vitest-environment jsdom
// One agent over a fake DataSource: the header and each of the five sections
// in its ok, empty, denied and error states, with an axe check in every one.
// Only the chosen section makes its own read; an unknown agent is a 404.
import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("links the five sections a store backs, and no Mandates, Budgets or Runs tab (negative)", async () => {
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
    ]);
    expect(document.body).not.toHaveTextContent(/mandate|budget|trust|score/i);
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
    const calls = await renderAgent({ get: readOk(agentDetail()) }, "mandates");
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
      "Mar 1, 2027, 10:00 AM",
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
