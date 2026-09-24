// @vitest-environment jsdom
// The Runtimes pages over a fake DataSource (roadmap mockups/pages/runtimes.md):
// the list and one runtime in every state the spec lists, the dialogs the page
// opens, and the one write, with an axe check in every render. A value no
// store records renders as not recorded and names its gap.
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
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { nth } from "@/test/nth";
import { phoneWidth } from "@/test/phone";
import {
  enrollment,
  memberList,
  runtimeAgent,
  runtimeList,
  runtimesSource,
} from "./runtimes.builders";

const refresh = vi.fn();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  notFound: () => notFound(),
}));
const unenrollRuntime = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("./actions", () => ({
  unenrollRuntime: (...args: unknown[]) => unenrollRuntime(...args),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Runtimes } = await import("./runtimes");
const { Runtime } = await import("./runtime");
const { RuntimesLoading } = await import("./loading");

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

async function renderList(
  reads: Parameters<typeof runtimesSource>[0],
  options: { container?: HTMLElement } = {},
) {
  const { source, calls } = runtimesSource(reads);
  const element = await Runtimes({
    ctx,
    source,
    org: "acme",
    ws: "core-platform",
    viewerName: "Marcus Bell",
  });
  render(<IntlProvider>{element}</IntlProvider>, options);
  return calls;
}

async function renderDetail(
  reads: Parameters<typeof runtimesSource>[0],
  runtime = enrollment().id,
  options: { container?: HTMLElement } = {},
) {
  const { source, calls } = runtimesSource(reads);
  const element = await Runtime({
    ctx,
    source,
    org: "acme",
    ws: "core-platform",
    runtime,
    viewerName: "Marcus Bell",
  });
  render(<IntlProvider>{element}</IntlProvider>, options);
  return calls;
}

const goldButtons = () =>
  [...document.querySelectorAll("a, button")].filter((el) =>
    el.className.includes("bg-button-primary-bg"),
  );

beforeEach(() => {
  unenrollRuntime.mockReset();
  refresh.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Runtimes, loaded", () => {
  it("draws the header, the four tiles, the hosts table and the ladder in the spec's order", async () => {
    await renderList({
      list: runtimeList([
        enrollment(),
        enrollment({
          id: "tch_cirunner07aaaaaaaaaaaaa",
          hostname: "ci-runner-07",
          platform: "linux",
          harnesses: ["stella"],
          claudeVersionAtEnroll: null,
          agentKey: "acme.core.stella-ci",
          modelRoute: "direct",
        }),
        enrollment({
          id: "tch_mbellmbp16bbbbbbbbbbbbb",
          agentKey: "acme.core.release-manager",
          status: "revoked",
          revokedAt: "2026-09-20T10:00:00.000Z",
        }),
        enrollment({
          id: "tch_mbellmbp16ccccccccccccc",
          agentKey: "acme.core.expired-bot",
          expiresAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    });
    expect(screen.getByText("Core platform")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Runtimes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The hosts agents run on, and what each host’s seam earns.",
      ),
    ).toBeInTheDocument();
    const enroll = screen.getByTestId("runtimes-enroll");
    expect(enroll).toHaveTextContent("Enroll a runtime");
    expect(enroll).toHaveAttribute("href", "/acme/core-platform/register/name");
    expect(goldButtons()).toEqual([enroll]);

    const tiles = screen.getByTestId("runtimes-tiles");
    expect(
      within(tiles)
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual(["Runtimes", "Agents hosted", "Highest tier earned", "Degraded"]);
    // Two distinct agents on a host still enrolled: the revoked enrollment
    // and the expired one are not hosted, as their Health cells say.
    expect(
      within(screen.getByTestId("tile-agents")).getByText("2"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("tile-agents")).toHaveTextContent(
      "a host is shared; its hooks see every one of them",
    );
    expect(screen.getByTestId("tile-runtimes")).toHaveTextContent(
      "4 agent enrollments recorded; no host row yet",
    );
    for (const id of ["tile-runtimes", "tile-tier", "tile-degraded"])
      expect(
        screen.getByTestId(id).querySelector("[data-not-backed]"),
      ).toHaveTextContent("not recorded");
    expect(screen.getByTestId("tile-tier")).toHaveTextContent(
      "computed per run from what was actually routed",
    );
    expect(screen.getByTestId("tile-degraded")).toHaveTextContent(
      "a gap is a hole in the record, not a failed run",
    );

    const hosts = screen.getByRole("region", { name: "Enrolled hosts" });
    // The design badges the runtime count, which no store holds (#3816): the
    // badge is not recorded, never the enrollment count read as hosts.
    const badge = within(hosts).getByTestId("runtimes-hosts-count");
    expect(badge).toHaveTextContent(/^not recorded$/);
    expect(badge.querySelector("[data-not-backed]")).toHaveAttribute(
      "data-gap",
      "#3816",
    );
    // The design's list controls: search, Rows and the pager.
    expect(
      within(hosts).getByRole("searchbox", { name: "Search this list" }),
    ).toBeInTheDocument();
    expect(within(hosts).getByRole("combobox", { name: "Rows" })).toHaveValue(
      "10",
    );
    expect(within(hosts).getByTestId("list-pager")).toHaveTextContent(
      "1–4 of 4",
    );
    // Four rows, and Health reads two values: the design's rule offers it.
    // Kind reads not recorded on every row and offers nothing.
    const health = within(hosts).getByRole("combobox", {
      name: "Filter by Health",
    });
    expect(
      [...health.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["All · Health", "not enrolled", "not recorded"]);
    expect(
      within(hosts).queryByRole("combobox", { name: "Filter by Kind" }),
    ).toBeNull();
    expect(
      within(hosts)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Runtime",
      "Kind",
      "Harness",
      "Model surface",
      "Tier",
      "Agents",
      "Collector",
      "Hooks",
      "Health",
      "Last checkpoint",
    ]);
    // Nothing but the table and the note: the spec draws no paragraph above it.
    expect(within(hosts).queryByTestId("runtimes-record")).toBeNull();
    expect(hosts).toHaveTextContent(
      "The tier is a property of the seam, not of the agent: two agents on one host earn the same tier, and the same agent moved to a weaker host earns less. It is computed per run from what was actually routed and is never upgraded after the fact.",
    );

    const ladder = screen.getByRole("region", { name: "The tier ladder" });
    expect(
      [...within(ladder).getByTestId("tier-ladder").querySelectorAll("li")].map(
        (li) => li.getAttribute("data-rung"),
      ),
    ).toEqual(["observe", "harness", "gateway", "contained"]);
    expect(ladder).toHaveTextContent(
      "Only contained earns the word enforced. On observe nothing is delivered and nothing can refuse",
    );
  });

  it("prints what the record carries on a row and names the gap for what it does not", async () => {
    await renderList({ list: runtimeList([enrollment()]) });
    const row = screen.getByTestId("runtime-row");
    const cells = within(row).getAllByRole("cell");
    const link = within(nth(cells, 0, "cell")).getByRole("link", {
      name: "Open mbell-mbp-16",
    });
    expect(link).toHaveAttribute(
      "href",
      "/acme/core-platform/runtimes/tch_mbellmbp16aaaaaaaaaaaaa",
    );
    // The row opens the runtime: the link is stretched over the whole row.
    expect(row).toHaveClass("relative", "cursor-pointer");
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");
    expect(cells[0]).toHaveTextContent("macOS 15.6 · arm64");
    expect(
      nth(cells, 1, "cell").querySelector("[data-not-backed]"),
    ).toHaveAttribute("data-gap", "#3816");
    // The one version the record holds, labelled as what it is.
    expect(cells[2]).toHaveTextContent("Claude Code 2.1.4 at enrollment");
    expect(cells[3]).toHaveTextContent("loopback proxy");
    expect(
      nth(cells, 4, "cell").querySelector("[data-not-backed]"),
    ).toHaveAttribute("data-gap", "#3817");
    // The count, then the key under it, right-aligned as the mockup's
    // `td.num`; the count takes the cell's face, not a mono span of its own.
    expect(cells[5]).toHaveTextContent(/^1acme\.core\.release-manager$/);
    expect(cells[5]).toHaveClass("text-right", "tabular-nums");
    expect(cells[7]).toHaveClass("text-right", "tabular-nums");
    for (const name of ["Agents", "Hooks"])
      expect(screen.getByRole("columnheader", { name })).toHaveClass(
        "text-right",
      );
    expect(cells[6]).toHaveTextContent("tachod 1.6.2");
    expect(cells[6]).toHaveTextContent("gaps in 24h not recorded");
    expect(cells[7]).toHaveTextContent(/^count not recorded$/);
    // Healthy and degraded come from the 24-hour gap count (#3818); an
    // enrolled host's health is not recorded, never a green word.
    const health = nth(cells, 8, "cell").querySelector("[data-health]");
    expect(health).toHaveAttribute("data-health", "not_recorded");
    expect(health?.querySelector("[data-not-backed]")).toHaveAttribute(
      "data-gap",
      "#3818",
    );
    expect(cells[8]).toHaveTextContent(/^not recorded$/);
    expect(
      nth(cells, 9, "cell").querySelector("[data-not-backed]"),
    ).toHaveAttribute("data-gap", "#3817");
  });

  it("reads an unreported model route, a missing hook report, an expired enrollment and a row with no agent", async () => {
    await renderList({
      list: runtimeList(
        [
          enrollment({
            modelRoute: null,
            expiresAt: "2026-01-01T00:00:00.000Z",
            agentKey: "",
            harnesses: [],
            collectorVersion: null,
            shadowedBy: null,
          }),
        ],
        true,
      ),
    });
    const cells = within(screen.getByTestId("runtime-row")).getAllByRole(
      "cell",
    );
    expect(cells[2]).toHaveTextContent("none reported");
    expect(cells[3]).toHaveTextContent("not reported");
    expect(cells[5]).toHaveTextContent(/^0enrolled, nothing assigned$/);
    // A daemon that has not reported yet is not a backend gap: no data-gap.
    const collector = nth(cells, 6, "cell");
    expect(collector.firstElementChild).toHaveTextContent("not reported yet");
    expect(collector.firstElementChild).not.toHaveAttribute("data-gap");
    const health = nth(cells, 8, "cell").querySelector("[data-health]");
    expect(health).toHaveAttribute("data-health", "not_enrolled");
    expect(health).toHaveTextContent("not enrolled");
    expect(screen.getByTestId("runtimes-more")).toHaveTextContent(
      "The first 1 enrollments are listed.",
    );
  });

  it("searches, filters, sorts and pages the hosts with the design's list controls", async () => {
    const hosts = Array.from({ length: 12 }, (_, index) =>
      enrollment({
        id: `tch_host${String(index).padStart(2, "0")}aaaaaaaaaaaaaaaa`,
        hostname: `host-${String(index).padStart(2, "0")}`,
        agentKey: `acme.core.agent-${index}`,
        ...(index === 3
          ? { status: "revoked", revokedAt: "2026-09-20T10:00:00.000Z" }
          : {}),
      }),
    );
    await renderList({ list: runtimeList(hosts) });
    const shown = () =>
      screen
        .getAllByTestId("runtime-row")
        .filter((row) => !row.hidden)
        .map((row) => row.querySelector("a")?.textContent);
    const pager = screen.getByTestId("list-pager");
    expect(pager).toHaveTextContent("1–10 of 12");
    expect(shown()).toHaveLength(10);
    fireEvent.click(within(pager).getByRole("button", { name: "Page 2" }));
    expect(pager).toHaveTextContent("11–12 of 12");
    expect(shown()).toEqual(["host-10", "host-11"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Rows" }), {
      target: { value: "0" },
    });
    expect(shown()).toHaveLength(12);

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search this list" }),
      {
        target: { value: "HOST-07" },
      },
    );
    expect(shown()).toEqual(["host-07"]);
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search this list" }),
      {
        target: { value: "nothing like this" },
      },
    );
    expect(screen.getByTestId("list-no-match")).toHaveTextContent(
      "No rows match.",
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search this list" }),
      {
        target: { value: "" },
      },
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by Health" }),
      {
        target: { value: "not enrolled" },
      },
    );
    expect(shown()).toEqual(["host-03"]);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by Health" }),
      {
        target: { value: "" },
      },
    );

    const runtime = screen.getByRole("columnheader", { name: "Runtime" });
    fireEvent.click(within(runtime).getByRole("button"));
    expect(runtime).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(runtime).getByRole("button"));
    expect(runtime).toHaveAttribute("aria-sort", "descending");
    expect(shown()[0]).toBe("host-11");
  });

  it("names a shadowing settings file and a harness this build does not know", async () => {
    await renderList({
      list: runtimeList([
        enrollment({
          harnesses: ["codex", "acme-bot"],
          modelRoute: "direct",
          shadowedBy: "/etc/managed-settings.json",
          osVersion: null,
          arch: null,
        }),
      ]),
    });
    const cells = within(screen.getByTestId("runtime-row")).getAllByRole(
      "cell",
    );
    expect(cells[0]).toHaveTextContent(
      "macOS · version and architecture not reported",
    );
    expect(cells[2]).toHaveTextContent("Codex CLI version not recorded");
    expect(cells[2]).toHaveTextContent("acme-bot version not recorded");
    // Enrollment records Claude Code's version alone (#3919).
    for (const version of cells[2]?.querySelectorAll("[data-not-backed]") ?? [])
      expect(version).toHaveAttribute("data-gap", "#3919");
    expect(cells[3]).toHaveTextContent("provider direct");
    expect(cells[3]).toHaveTextContent(
      "overridden by /etc/managed-settings.json",
    );
  });
});

describe("Runtimes, not loaded", () => {
  it("shows the empty state with the spec's copy, one gold action and the CLI path", async () => {
    await renderList({ list: runtimeList([]) });
    const empty = screen.getByTestId("runtimes-empty");
    expect(
      within(empty).getByRole("heading", { name: "No runtime is enrolled" }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "Until a host enrolls, an agent has an identity and a toolbelt but no hook is installed. Its runs are graded observe, and no report can say more.",
    );
    // The header keeps Enroll a runtime; the empty state's copy of it is the gold one.
    const enrolls = screen.getAllByTestId("runtimes-enroll");
    expect(enrolls).toHaveLength(2);
    expect(goldButtons()).toEqual([nth(enrolls, 1, "enroll link")]);
    fireEvent.click(
      within(empty).getByRole("button", { name: "Show the CLI path" }),
    );
    const dialog = await screen.findByTestId("runtimes-cli-dialog");
    expect(dialog).toHaveTextContent("oxagen agent enroll");
    expect(dialog).toHaveTextContent(
      "Nothing on this page installs a hook. Enrollment runs on the host itself.",
    );
  });

  it("replaces the body, header included, with the error state and its trace line", async () => {
    await renderList({ list: readError("collector_unreachable", 503) });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const error = screen.getByTestId("runtimes-error");
    expect(
      within(error).getByRole("heading", {
        name: "Runtimes could not be loaded",
      }),
    ).toBeInTheDocument();
    expect(error).toHaveTextContent(
      "The control plane answered 503 collector_unreachable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    // The kernel's error carries no trace id or region (#3841).
    const trace = screen.getByTestId("runtimes-trace");
    expect(trace).toHaveTextContent(
      /^trace not recorded · region not recorded · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
    );
    for (const gap of trace.querySelectorAll("[data-not-backed]"))
      expect(gap).toHaveAttribute("data-gap", "#3841");
    fireEvent.click(within(error).getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
    fireEvent.click(
      within(error).getByRole("button", { name: "Open an incident" }),
    );
    const dialog = await screen.findByTestId("runtimes-incident-dialog");
    expect(dialog).toHaveTextContent(
      "No capability opens an incident from the console yet.",
    );
  });

  it("replaces the body with access denied, naming runtime.read on the workspace", async () => {
    await renderList({
      list: { ok: false, reason: "denied", permission: "runtime.read" },
    });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const denied = screen.getByTestId("runtimes-denied");
    expect(
      within(denied).getByRole("heading", {
        name: "You cannot see the runtimes of this workspace",
      }),
    ).toBeInTheDocument();
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include runtime.read on core-platform.",
    );
    expect(
      within(denied)
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual(["Signed in as", "Needed", "Decided by"]);
    expect(screen.getByTestId("runtimes-signed-in")).toHaveTextContent(
      "Marcus Bell · workspace.member · core-platform",
    );
    const decided = screen.getByTestId("runtimes-decided-by");
    expect(decided).toHaveTextContent(
      "policy not recorded · deny wins over every allow",
    );
    expect(decided.querySelector("[data-not-backed]")).toHaveAttribute(
      "data-gap",
      "#3841",
    );
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    fireEvent.click(
      within(denied).getByRole("button", { name: "Request access" }),
    );
    const dialog = await screen.findByTestId("runtimes-request-access-dialog");
    expect(dialog).toHaveTextContent("runtime.read on core-platform");
    expect(
      within(dialog).getByRole("link", { name: "Open Roles" }),
    ).toHaveAttribute("href", "/acme/roles");
  });

  it("names the access request a parked read is waiting on", async () => {
    await renderList({
      list: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_42",
      },
    });
    expect(screen.getByTestId("runtimes-pending")).toHaveTextContent(
      "Access request acr_42",
    );
  });

  it("draws the skeleton with four tiles and a panel of seven rows", () => {
    render(
      <IntlProvider>
        <RuntimesLoading />
      </IntlProvider>,
    );
    const loading = screen.getByTestId("runtimes-loading");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Reading the runtimes of this workspace");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

describe("One runtime", () => {
  it("draws the back button, the host facts in the spec's order, the agents and the rollback", async () => {
    const calls = await renderDetail({ list: runtimeList([enrollment()]) });
    expect(calls.agents).toEqual([["acme.core.release-manager"]]);
    expect(screen.getByTestId("runtime-back")).toHaveTextContent(
      "← All runtimes",
    );
    expect(screen.getByTestId("runtime-back")).toHaveAttribute(
      "href",
      "/acme/core-platform/runtimes",
    );
    const host = screen.getByRole("region", { name: "mbell-mbp-16" });
    const subtitle = screen.getByTestId("runtime-subtitle");
    expect(subtitle).toHaveTextContent(
      "kind not recorded · macOS 15.6 · arm64 · started by not recorded",
    );
    for (const gap of subtitle.querySelectorAll("[data-not-backed]"))
      expect(gap).toHaveAttribute("data-gap", "#3816");
    expect(host.querySelector("[data-health]")).toHaveTextContent(
      "health not recorded",
    );
    expect(
      within(host)
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual([
      "Workspace",
      "Owner",
      "Harness",
      "Collector",
      "Hook binary",
      "Hooks written",
      "Model surface",
      "Settings",
      "Tier earned",
      "Last checkpoint",
    ]);
    expect(screen.getByTestId("fact-workspace")).toHaveTextContent(
      "Core platform",
    );
    expect(screen.getByTestId("fact-collector")).toHaveTextContent(
      "tachod 1.6.2telemetry gaps in the last 24h not recorded",
    );
    expect(screen.getByTestId("fact-hook-binary")).toHaveTextContent(
      "tacho-hook 1.6.2 · fails closed against its cached bundle",
    );
    expect(screen.getByTestId("fact-model-surface")).toHaveTextContent(
      "every harness config names the loopback proxy",
    );
    expect(screen.getByTestId("fact-tier")).toHaveTextContent(
      "computed per run from what was actually routed",
    );
    // Where the installer wrote the hooks, as enrollment recorded it.
    expect(screen.getByTestId("fact-settings")).toHaveTextContent(
      /^user settings$/,
    );
    for (const id of ["fact-checkpoint", "fact-hooks-written"])
      expect(
        screen.getByTestId(id).querySelector("[data-not-backed]"),
      ).toBeInTheDocument();

    const agents = screen.getByRole("region", { name: "Agents on this host" });
    expect(
      within(agents)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Agent", "Operator", "Tier", "Principal", "Runs 30d"]);
    const row = within(agents).getByTestId("runtime-agent-row");
    // The design's agent card names the harness under the key.
    expect(nth(within(row).getAllByRole("cell"), 0, "cell")).toHaveTextContent(
      "acme.core.release-managerClaude Code",
    );
    expect(within(agents).getByTestId("list-pager")).toHaveTextContent(
      "1–1 of 1",
    );
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-manager",
    );
    // The operator by name from the roster; the id is the key the hover card
    // holds, never the label.
    const operator = within(row).getByTestId("runtime-operator");
    expect(operator).toHaveTextContent(/^Marcus Bell$/);
    expect(operator).toHaveAttribute("data-operator-id", "usr_marcusbell");
    expect(row).not.toHaveTextContent("usr_marcusbell");
    expect(row).toHaveTextContent("prn_01JQ8W3F2M6XKD7A9RZT4BVCNE");
    expect(row).toHaveTextContent("212");
    expect(agents).toHaveTextContent(
      "Every agent here is seen through the same hooks and earns the same tier. An agent’s identity, its steering and its toolbelt are its own; only the seam is shared.",
    );

    const rollback = screen.getByRole("region", { name: "Rollback" });
    expect(screen.getByTestId("runtime-unenroll-command")).toHaveTextContent(
      "oxagen agent unenroll release-manager \\ --host tch_mbellmbp16aaaaaaaaaaaaa",
    );
    expect(rollback).toHaveTextContent(
      "If hooks are stripped by hand instead, the next run records hooks_removed and the tier falls to observe. It is never upgraded after the fact.",
    );
    expect(
      within(rollback).getByRole("button", { name: "Run a smoke session" }),
    ).toBeInTheDocument();
    expect(
      within(rollback).getByRole("button", { name: "Unenroll" }),
    ).toBeInTheDocument();
    expect(goldButtons()).toEqual([screen.getByTestId("runtimes-enroll")]);
  });

  it("says a host with no agent records nothing, and reads no agent", async () => {
    const calls = await renderDetail({
      list: runtimeList([enrollment({ agentKey: "" })]),
    });
    expect(calls.agents).toEqual([]);
    expect(calls.members).toBe(0);
    expect(screen.getByTestId("runtime-agents-none")).toHaveTextContent(
      "This host is enrolled and no agent is assigned to it. It records nothing until one runs here.",
    );
    expect(screen.getByTestId("runtime-agents-count")).toHaveTextContent("0");
  });

  it("names no operator it cannot find, and never labels one by its id", async () => {
    await renderDetail({
      list: runtimeList([enrollment()]),
      members: readError("list_members_unavailable", 503),
    });
    const operator = screen.getByTestId("runtime-operator");
    expect(operator).toHaveTextContent(/^Operator$/);
    expect(operator).toHaveAttribute("data-operator-id", "usr_marcusbell");
    cleanup();
    await renderDetail({
      list: runtimeList([enrollment()]),
      members: memberList([]),
    });
    expect(screen.getByTestId("runtime-operator")).toHaveTextContent(
      /^Operator$/,
    );
  });

  it("names managed settings when the installer wrote the hooks there", async () => {
    await renderDetail({
      list: runtimeList([enrollment({ managed: true })]),
    });
    expect(screen.getByTestId("fact-settings")).toHaveTextContent(
      /^managed settings$/,
    );
  });

  it("reads a host whose harnesses route differently as both routes, never as the proxy", async () => {
    await renderDetail({
      list: runtimeList([enrollment({ modelRoute: "mixed" })]),
    });
    expect(screen.getByTestId("fact-model-surface")).toHaveTextContent(
      "loopback proxy and provider directsome harness configs name the loopback proxy and some send model traffic to the provider direct",
    );
    expect(screen.getByTestId("fact-model-surface")).not.toHaveTextContent(
      "every harness config",
    );
  });

  it("keeps the host when the agents read fails, and names the failure in its panel", async () => {
    await renderDetail({
      list: runtimeList([
        enrollment({ mode: "observe", modelRoute: "direct" }),
      ]),
      agents: readError("iam_principals_unavailable", 503),
    });
    expect(screen.getByTestId("runtime-agents-failed")).toHaveTextContent(
      "iam_principals_unavailable",
    );
    expect(screen.getByTestId("fact-hook-binary")).toHaveTextContent(
      "allows when its bundle is stale, because this host is in observe mode",
    );
    expect(screen.getByTestId("fact-model-surface")).toHaveTextContent(
      "routing it is the gateway tier",
    );
  });

  it("marks an agent the workspace does not list, and keeps Unenroll on a revoked host, which the write answers idempotently", async () => {
    await renderDetail({
      list: runtimeList([
        enrollment({
          status: "revoked",
          revokedAt: "2026-09-20T10:00:00.000Z",
        }),
      ]),
      agents: readOk({
        agents: [runtimeAgent({ agentKey: "acme.core.other" })],
      }),
    });
    const row = screen.getByTestId("runtime-agent-row");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(row).toHaveTextContent("not among this workspace's identities");
    expect(
      screen.getByRole("button", { name: "Unenroll" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("region", { name: "mbell-mbp-16" })
        .querySelector("[data-health]"),
    ).toHaveTextContent("not enrolled");
    expect(screen.getByTestId("runtime-unenroll-command")).toHaveTextContent(
      "oxagen agent unenroll release-manager",
    );
  });

  it("is a 404 for an id the workspace does not hold", async () => {
    await expect(
      renderDetail(
        { list: runtimeList([enrollment()]) },
        "tch_nosuchaaaaaaaaaaaaaaaa",
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("replaces the body with the error and denied states", async () => {
    await renderDetail({ list: readError("collector_unreachable", 503) });
    expect(screen.getByTestId("runtimes-error")).toBeInTheDocument();
    cleanup();
    await renderDetail({
      list: { ok: false, reason: "denied", permission: "runtime.read" },
    });
    expect(screen.getByTestId("runtimes-denied")).toBeInTheDocument();
  });

  it("opens the smoke session stub, which says what it would do", async () => {
    await renderDetail({ list: runtimeList([enrollment()]) });
    fireEvent.click(
      screen.getByRole("button", { name: "Run a smoke session" }),
    );
    const dialog = await screen.findByTestId("runtime-smoke-dialog");
    expect(dialog).toHaveTextContent(
      "A smoke session would run one turn on mbell-mbp-16, recorded like any other run",
    );
    expect(dialog.querySelector("[data-not-backed='smoke']")).toHaveAttribute(
      "data-gap",
      "#3819",
    );
  });

  it("unenrolls behind a confirming dialog and re-reads the page", async () => {
    unenrollRuntime.mockResolvedValue({
      ok: true,
      value: { revokedAt: "2026-09-23T10:00:00.000Z" },
    });
    await renderDetail({ list: runtimeList([enrollment()]) });
    fireEvent.click(screen.getByRole("button", { name: "Unenroll" }));
    const dialog = await screen.findByTestId("runtime-unenroll-dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Unenroll mbell-mbp-16?" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "Calls routed through Oxagen are refused from this host from now on. The hooks stay on the host until the rollback command runs there",
    );
    expect(screen.getByTestId("runtime-unenroll-warn")).toHaveTextContent(
      "This revokes the enrollment of acme.core.release-manager on this machine.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Keep it enrolled" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unenroll it" }),
    );
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledOnce();
    });
    expect(unenrollRuntime).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tch_mbellmbp16aaaaaaaaaaaaa",
    );
  });

  it.each([
    [
      { ok: false, reason: "denied", code: "authz_denied" },
      "Your roles do not let you unenroll a host. An organization Owner or Admin can. Nothing was changed.",
    ],
    [
      { ok: false, reason: "not_found", code: "not_found" },
      "This enrollment no longer exists. Nothing was changed.",
    ],
    [
      { ok: false, reason: "conflict", code: "already_revoked" },
      "This write was refused: already_revoked. Nothing was changed.",
    ],
    [
      { ok: false, reason: "invalid", code: "invalid_input" },
      "This enrollment id is not one the write accepts. Nothing was changed.",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_9" },
      "This write is waiting for approval. Access request acr_9.",
    ],
    [
      { ok: false, reason: "unavailable", code: "contract_output_mismatch" },
      "This write could not be answered: contract_output_mismatch. Nothing was changed.",
    ],
  ])(
    "names a refused unenroll in the dialog and changes nothing (%#)",
    async (result, text) => {
      unenrollRuntime.mockResolvedValue(result);
      await renderDetail({ list: runtimeList([enrollment()]) });
      fireEvent.click(screen.getByRole("button", { name: "Unenroll" }));
      const dialog = await screen.findByTestId("runtime-unenroll-dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Unenroll it" }),
      );
      expect(
        await within(dialog).findByTestId("runtime-unenroll-failure"),
      ).toHaveTextContent(text);
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it("names a write that threw before it answered", async () => {
    unenrollRuntime.mockRejectedValue(new Error("network"));
    await renderDetail({ list: runtimeList([enrollment()]) });
    fireEvent.click(screen.getByRole("button", { name: "Unenroll" }));
    const dialog = await screen.findByTestId("runtime-unenroll-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unenroll it" }),
    );
    expect(
      await within(dialog).findByTestId("runtime-unenroll-failure"),
    ).toHaveTextContent(
      "This write could not be answered: action_failed. Nothing was changed.",
    );
  });
});

describe("A daemon that has not reported", () => {
  it("prints not reported yet for the collector and the hook, with no gap", async () => {
    await renderDetail({
      list: runtimeList([enrollment({ collectorVersion: null })]),
    });
    for (const id of ["fact-collector", "fact-hook-binary"]) {
      const fact = screen.getByTestId(id);
      expect(fact.firstElementChild).toHaveTextContent("not reported yet");
      expect(fact.firstElementChild).not.toHaveAttribute("data-gap");
    }
  });
});

describe("Runtimes on a phone", () => {
  // runtimes.md, Mobile: touch targets are 44 px or larger, and the ladder
  // keeps the mockup's two columns at 390 px.
  it("keeps the row links and every control a 44px touch target, and the ladder two to a row", async () => {
    const phone = phoneWidth();
    try {
      await renderList(
        { list: runtimeList([enrollment()]) },
        { container: phone.container },
      );
      const link = within(phone.container).getByRole("link", {
        name: "Open mbell-mbp-16",
      });
      expect(link).toHaveAttribute("data-touch-target");
      const targets = phone.container.querySelectorAll("[data-touch-target]");
      expect(targets.length).toBeGreaterThan(1);
      for (const target of targets)
        expect(getComputedStyle(target).minHeight).toBe("44px");
      const ladder = within(phone.container).getByTestId("tier-ladder");
      expect(ladder).toHaveClass("grid-cols-2", "lg:grid-cols-4");
      // The mockup's phone rule draws the four tiles two to a row.
      expect(within(phone.container).getByTestId("runtimes-tiles")).toHaveClass(
        "grid-cols-2",
      );
    } finally {
      phone.restore();
    }
  });

  it("makes the agent row's link a 44px target that opens the agent from the whole row", async () => {
    const phone = phoneWidth();
    try {
      await renderDetail(
        { list: runtimeList([enrollment()]) },
        enrollment().id,
        { container: phone.container },
      );
      const row = within(phone.container).getByTestId("runtime-agent-row");
      expect(row).toHaveClass("relative", "cursor-pointer");
      const link = within(row).getByRole("link");
      expect(link).toHaveAttribute("data-touch-target");
      expect(getComputedStyle(link).minHeight).toBe("44px");
      expect(link.className).toContain("after:inset-0");
    } finally {
      phone.restore();
    }
  });
});
