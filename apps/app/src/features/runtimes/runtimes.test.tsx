// @vitest-environment jsdom
// The Runtimes tab of the Agents page over a fake DataSource (roadmap mockups
// `agtRuntimesTab()` and `agt-runtime`): the one table with the design's five
// columns in every state the tab can reach, one runtime in the drawer over the
// tab, the dialogs the drawer opens, the named runtimes and Add a runtime
// (ADR-198), a named runtime's drawer and its Containment switch (ADR-204),
// and the writes, with an axe check in every render. A value no store records
// renders as not recorded and names its gap.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { nth } from "@/test/nth";
import { phoneWidth } from "@/test/phone";
import { optionNames, pickOption } from "@/test/select";
import {
  enrollment,
  memberList,
  namedRuntime,
  namedRuntimeList,
  runtimeAgent,
  runtimeList,
  runtimesSource,
} from "./runtimes.builders";

const refresh = vi.fn();
const push = vi.fn();
const replace = vi.fn();
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, refresh }),
}));
const unenrollRuntime = vi.fn<(...args: unknown[]) => unknown>();
const createRuntime = vi.fn<(...args: unknown[]) => unknown>();
const setRuntimeContainment = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("./actions", () => ({
  unenrollRuntime: (...args: unknown[]) => unenrollRuntime(...args),
  createRuntime: (...args: unknown[]) => createRuntime(...args),
  setRuntimeContainment: (...args: unknown[]) => setRuntimeContainment(...args),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Runtimes, seenState } = await import("./runtimes");
const { RuntimeInDrawer } = await import("./runtime");
const { RuntimesLoading } = await import("./loading");
const { AddRuntime } = await import("./controls");

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

const memberCtx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** An instant `minutes` before now, as the record stamps one. */
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

async function renderList(
  reads: Parameters<typeof runtimesSource>[0],
  options: { container?: HTMLElement; viewer?: typeof ctx } = {},
) {
  const { source, calls } = runtimesSource(reads);
  const element = await Runtimes({
    ctx: options.viewer ?? ctx,
    source,
    org: "acme",
    ws: "core-platform",
    viewerName: "Marcus Bell",
  });
  render(
    <IntlProvider>{element}</IntlProvider>,
    options.container === undefined ? {} : { container: options.container },
  );
  return calls;
}

/** One runtime in the drawer over the tab; the drawer renders in a portal on the body. */
async function renderDetail(
  reads: Parameters<typeof runtimesSource>[0],
  runtime = enrollment().id,
  viewer = ctx,
) {
  const { source, calls } = runtimesSource(reads);
  const element = await RuntimeInDrawer({
    ctx: viewer,
    source,
    org: "acme",
    ws: "core-platform",
    runtime,
    viewerName: "Marcus Bell",
  });
  render(<IntlProvider>{element}</IntlProvider>);
  await screen.findByTestId("runtime-drawer");
  return calls;
}

/** Add a runtime, as the Runtimes tab draws it for an Owner or Admin. */
async function openAddRuntime() {
  render(
    <IntlProvider>
      <AddRuntime org="acme" ws="core-platform" gold={false} />
    </IntlProvider>,
  );
  fireEvent.click(screen.getByTestId("runtimes-add"));
  return screen.findByTestId("runtimes-add-dialog");
}

/** One row of the table, by the runtime's id. */
const rowOf = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`tr[data-runtime="${id}"]`);
  if (found === null) throw new Error(`no row for ${id}`);
  return found;
};

/** The Health cell's words, one per badge, in the order they are drawn. */
const healthOf = (id: string) =>
  [...rowOf(id).querySelectorAll("[data-health]")].map((node) =>
    node.getAttribute("data-health"),
  );

const goldButtons = () =>
  [...document.querySelectorAll("a, button")].filter((el) =>
    el.className.includes("bg-button-primary-bg"),
  );

beforeEach(() => {
  unenrollRuntime.mockReset();
  createRuntime.mockReset();
  setRuntimeContainment.mockReset();
  refresh.mockReset();
  push.mockReset();
  replace.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("seenState", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");

  it("reads a runtime that never reported as unseen", () => {
    expect(seenState(null, now)).toBe("unseen");
  });

  it("reads a runtime seen within the day as seen", () => {
    expect(seenState("2026-09-24T11:00:00.000Z", now)).toBe("seen");
    expect(seenState("2026-09-23T12:00:01.000Z", now)).toBe("seen");
  });

  it("reads a runtime unseen for a day or more as offline", () => {
    expect(seenState("2026-09-23T12:00:00.000Z", now)).toBe("offline");
    expect(seenState("2026-09-01T00:00:00.000Z", now)).toBe("offline");
  });
});

describe("Runtimes tab, loaded", () => {
  it("draws one table with the design's five columns, the named runtimes first, and Add a runtime above it in the default style", async () => {
    await renderList({
      list: runtimeList([
        enrollment({ lastSeenAt: ago(5) }),
        enrollment({
          id: "tch_cirunner07aaaaaaaaaaaaa",
          hostname: "ci-runner-07",
          platform: "linux",
          agentKey: "",
          lastSeenAt: ago(3 * 24 * 60),
        }),
        enrollment({
          id: "tch_mbellmbp16bbbbbbbbbbbbb",
          status: "revoked",
          revokedAt: "2026-09-20T10:00:00.000Z",
        }),
      ]),
      named: namedRuntimeList([
        namedRuntime({ lastSeenAt: ago(5) }),
        namedRuntime({
          id: "rtm_gpubox",
          name: "GPU box",
          slug: "gpu-box",
          agents: [],
          liveHosts: 0,
          lastSeenAt: null,
        }),
      ]),
    });
    // The tab sits under the Agents page's header (features/agents/area.tsx).
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const table = screen.getByRole("table", { name: "Runtimes" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Runtime", "Kind", "Health", "Agents", "Last seen"]);
    expect(
      [...table.querySelectorAll("tr[data-runtime]")].map((row) =>
        row.getAttribute("data-runtime"),
      ),
    ).toEqual([
      "rtm_macslaptop",
      "rtm_gpubox",
      "tch_mbellmbp16aaaaaaaaaaaaa",
      "tch_cirunner07aaaaaaaaaaaaa",
      "tch_mbellmbp16bbbbbbbbbbbbb",
    ]);
    // The idle note counts a named runtime with no agent and a host with none.
    expect(screen.getByTestId("runtimes-idle")).toHaveTextContent(
      /^2 runtimes with no agent assigned\.$/,
    );
    // Add a runtime moved here from the header; Connect an agent in the header
    // stays the page's one gold action.
    expect(screen.getByTestId("runtimes-add")).toHaveTextContent(
      "Add a runtime",
    );
    expect(goldButtons()).toEqual([]);
    // The design's list controls: search, and the pager with Rows and the range.
    expect(
      screen.getByRole("searchbox", { name: "Search this list" }),
    ).toBeInTheDocument();
    const pager = screen
      .getByRole("navigation", { name: "Runtimes pages" })
      .closest("[data-rows-pager]");
    expect(pager?.querySelector("[data-range]")?.textContent).toBe(
      "1–5 of 5",
    );
    // The tiles, the enrolled hosts panel and the tier ladder are gone.
    expect(screen.queryByTestId("runtimes-tiles")).toBeNull();
    expect(screen.queryByTestId("tier-ladder")).toBeNull();
    expect(screen.queryByRole("region", { name: "Enrolled hosts" })).toBeNull();
  });

  it("prints what the record carries on a host row and names the gap for what it does not", async () => {
    const seen = ago(5);
    await renderList({ list: runtimeList([enrollment({ lastSeenAt: seen })]) });
    const row = screen.getByTestId("runtime-row");
    const cells = within(row).getAllByRole("cell");
    const link = within(nth(cells, 0, "cell")).getByRole("link", {
      name: "Open mbell-mbp-16",
    });
    // The row opens the runtime in the drawer over the tab.
    expect(link).toHaveAttribute(
      "href",
      "/acme/core-platform/agents?tab=runtimes&runtime=tch_mbellmbp16aaaaaaaaaaaaa",
    );
    expect(row).toHaveClass("relative", "cursor-pointer");
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");
    expect(cells[0]).toHaveTextContent("mbell-mbp-16macOS 15.6 · arm64");
    // The host kind has no store (#3816).
    expect(
      nth(cells, 1, "cell").querySelector("[data-not-backed]"),
    ).toHaveAttribute("data-gap", "#3816");
    // Seen within the day: healthy is judged from the gap count, which nothing
    // records (#3818), so the cell names the gap, never a green word.
    const health = nth(cells, 2, "cell").querySelector("[data-health]");
    expect(health).toHaveAttribute("data-health", "not_recorded");
    expect(health?.querySelector("[data-not-backed]")).toHaveAttribute(
      "data-gap",
      "#3818",
    );
    expect(cells[2]).toHaveTextContent(/^not recorded$/);
    // The agent's avatar carries the harness the agent registered.
    expect(cells[3]).toHaveTextContent(/acme\.core\.release-manager$/);
    expect(
      nth(cells, 3, "cell").querySelector("[data-harness-badge]"),
    ).toHaveAttribute("data-harness-badge", "claude-code");
    expect(nth(cells, 4, "cell").querySelector("time")).toHaveAttribute(
      "datetime",
      seen,
    );
  });

  it("badges a host row's agent with the harness it registered, not the one the machine detected", async () => {
    const calls = await renderList({
      list: runtimeList([
        enrollment({ harnesses: ["claude-code"] }),
        enrollment({
          id: "tch_strangeraaaaaaaaaaaaaa",
          agentKey: "acme.core.stranger",
        }),
        enrollment({ id: "tch_noagentaaaaaaaaaaaaaa", agentKey: "" }),
      ]),
      agents: readOk({ agents: [runtimeAgent({ harness: "custom" })] }),
    });
    // One read for the agents the rows name, each key once.
    expect(calls.agents).toEqual([
      ["acme.core.release-manager", "acme.core.stranger"],
    ]);
    const agentCell = (id: string) =>
      nth(within(rowOf(id)).getAllByRole("cell"), 3, "cell");
    expect(
      agentCell("tch_mbellmbp16aaaaaaaaaaaaa").querySelector(
        "[data-harness-badge]",
      ),
    ).toHaveAttribute("data-harness-badge", "custom");
    // An agent the read did not return names no badge (negative).
    expect(
      agentCell("tch_strangeraaaaaaaaaaaaaa").querySelector(
        "[data-harness-badge]",
      ),
    ).toBeNull();
  });

  it("keeps the table and draws no badge when the agents read fails (negative)", async () => {
    await renderList({
      list: runtimeList([enrollment()]),
      agents: readError("iam_principals_unavailable", 503),
    });
    const row = screen.getByTestId("runtime-row");
    expect(row).toHaveTextContent("acme.core.release-manager");
    expect(row.querySelector("[data-harness-badge]")).toBeNull();
  });

  it("reads each health word the record backs", async () => {
    await renderList({
      list: runtimeList([
        enrollment({
          id: "tch_offlineaaaaaaaaaaaaaaa",
          lastSeenAt: ago(25 * 60),
        }),
        enrollment({
          id: "tch_unseenaaaaaaaaaaaaaaaa",
          lastSeenAt: null,
          hooksOk: false,
        }),
        enrollment({
          id: "tch_revokedaaaaaaaaaaaaaaa",
          status: "revoked",
          revokedAt: "2026-09-20T10:00:00.000Z",
        }),
        enrollment({
          id: "tch_expiredaaaaaaaaaaaaaaa",
          expiresAt: "2026-01-01T00:00:00.000Z",
        }),
        enrollment({
          id: "tch_hooksokaaaaaaaaaaaaaaa",
          lastSeenAt: ago(5),
          hooksOk: true,
        }),
      ]),
    });
    expect(healthOf("tch_offlineaaaaaaaaaaaaaaa")).toEqual(["offline"]);
    expect(rowOf("tch_offlineaaaaaaaaaaaaaaa")).toHaveTextContent("Offline");
    // A host that never reported, whose hooks the collector read back
    // incomplete, carries both words.
    expect(healthOf("tch_unseenaaaaaaaaaaaaaaaa")).toEqual(["unseen", "hooks"]);
    expect(rowOf("tch_unseenaaaaaaaaaaaaaaaa")).toHaveTextContent(
      "Not seen yetHooks incomplete",
    );
    // A revoked or expired enrollment is not enrolled, whatever it last said.
    for (const id of [
      "tch_revokedaaaaaaaaaaaaaaa",
      "tch_expiredaaaaaaaaaaaaaaa",
    ]) {
      expect(healthOf(id)).toEqual(["not_enrolled"]);
      expect(rowOf(id)).toHaveTextContent("not enrolled");
    }
    // Hooks read back whole add nothing to the cell (negative).
    expect(healthOf("tch_hooksokaaaaaaaaaaaaaaa")).toEqual(["not_recorded"]);
  });

  it("lists a named runtime with its agents by harness and its live hosts, and Register an agent on one with none", async () => {
    await renderList({
      list: runtimeList([enrollment()]),
      named: namedRuntimeList([
        namedRuntime({ lastSeenAt: ago(5) }),
        namedRuntime({
          id: "rtm_gpubox",
          name: "GPU box",
          slug: "gpu-box",
          agents: [],
          liveHosts: 0,
          lastSeenAt: null,
        }),
      ]),
    });
    const laptop = rowOf("rtm_macslaptop");
    expect(laptop).toHaveAttribute("data-testid", "named-runtime");
    expect(laptop).toHaveClass("relative", "cursor-pointer");
    const open = within(laptop).getByRole("link", {
      name: "Open Mac's laptop",
    });
    expect(open).toHaveAttribute(
      "href",
      "/acme/core-platform/agents?tab=runtimes&runtime=rtm_macslaptop",
    );
    expect(open).toHaveTextContent(/^Mac's laptop$/);
    expect(open.className).toContain("after:inset-0");
    const cells = within(laptop).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("1 live host");
    expect(
      nth(cells, 1, "cell").querySelector("[data-not-backed]"),
    ).toHaveAttribute("data-gap", "#3816");
    expect(healthOf("rtm_macslaptop")).toEqual(["not_recorded"]);
    expect(cells[3]).toHaveTextContent("mac-claudeClaude Code");
    expect(cells[3]?.querySelector("[data-harness-badge]")).toHaveAttribute(
      "data-harness-badge",
      "claude-code",
    );

    const gpu = rowOf("rtm_gpubox");
    expect(gpu).toHaveTextContent("No host enrolled");
    // No host bound: nothing has reported, so the cell says why.
    expect(healthOf("rtm_gpubox")).toEqual(["no_host"]);
    expect(gpu).toHaveTextContent("No host");
    expect(gpu).toHaveTextContent("No agent yet");
    expect(gpu).toHaveTextContent("never");
    expect(
      within(gpu).getByRole("link", { name: "Register an agent on GPU box" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/register/name?runtime=rtm_gpubox",
    );
  });

  it("lists a named runtime with no enrollment rather than the empty state", async () => {
    await renderList({ list: runtimeList([]), named: namedRuntimeList() });
    expect(screen.queryByTestId("runtimes-empty")).toBeNull();
    expect(screen.getAllByTestId("named-runtime")).toHaveLength(1);
  });

  it("names the runtimes read's failure above the table and keeps the hosts (negative)", async () => {
    await renderList({
      list: runtimeList([enrollment()]),
      named: readError("runtimes_unavailable", 503),
    });
    expect(screen.queryByTestId("named-runtime")).toBeNull();
    expect(screen.getByTestId("runtimes-named-failed")).toHaveTextContent(
      "runtimes_unavailable",
    );
    expect(screen.getAllByTestId("runtime-row")).toHaveLength(1);
  });

  it("offers a member no Add a runtime and no Register an agent (negative)", async () => {
    await renderList(
      {
        list: runtimeList([enrollment()]),
        named: namedRuntimeList([namedRuntime({ agents: [] })]),
      },
      { viewer: memberCtx },
    );
    expect(screen.queryByTestId("runtimes-add")).toBeNull();
    expect(screen.queryByTestId("runtime-register-agent")).toBeNull();
    // The idle note still counts the runtime with no agent.
    expect(screen.getByTestId("runtimes-idle")).toHaveTextContent(
      /^1 runtime with no agent assigned\.$/,
    );
  });

  it("draws no idle note when every runtime has an agent", async () => {
    await renderList(
      { list: runtimeList([enrollment()]) },
      { viewer: memberCtx },
    );
    expect(screen.queryByTestId("runtimes-idle")).toBeNull();
  });

  it("reads an unreported OS, a host with no agent, and a walk that stopped at its bound", async () => {
    await renderList({
      list: runtimeList(
        [enrollment({ agentKey: "", osVersion: null, arch: null })],
        true,
      ),
    });
    const cells = within(screen.getByTestId("runtime-row")).getAllByRole(
      "cell",
    );
    expect(cells[0]).toHaveTextContent(
      "macOS (version and architecture not reported)",
    );
    expect(cells[3]).toHaveTextContent(/^No agent yet$/);
    expect(screen.getByTestId("runtimes-more")).toHaveTextContent(
      "The first 1 enrollments are listed. More are recorded than this tab reads.",
    );
  });

  it("prints the half of the OS a host reported", async () => {
    await renderList({
      list: runtimeList([
        enrollment({ id: "tch_versiononlyaaaaaaaaaaa", arch: null }),
        enrollment({
          id: "tch_archonlyaaaaaaaaaaaaaa",
          platform: "linux",
          osVersion: null,
        }),
      ]),
    });
    const first = (id: string) =>
      nth(within(rowOf(id)).getAllByRole("cell"), 0, "cell");
    // No architecture: the line stops at the version, with no dangling dot.
    expect(first("tch_versiononlyaaaaaaaaaaa")).toHaveTextContent(
      /macOS 15\.6$/,
    );
    expect(first("tch_versiononlyaaaaaaaaaaa")).not.toHaveTextContent("·");
    // No version: the architecture follows the platform's name alone.
    expect(first("tch_archonlyaaaaaaaaaaaaaa")).toHaveTextContent(
      /Linux · arm64$/,
    );
  });

  it("searches, filters, sorts and pages the runtimes with the design's list controls", async () => {
    const seen = ago(5);
    const hosts = Array.from({ length: 12 }, (_, index) =>
      enrollment({
        id: `tch_host${String(index).padStart(2, "0")}aaaaaaaaaaaaaaaa`,
        hostname: `host-${String(index).padStart(2, "0")}`,
        agentKey: `acme.core.agent-${String(index)}`,
        lastSeenAt: seen,
        ...(index === 3
          ? { status: "revoked", revokedAt: "2026-09-20T10:00:00.000Z" }
          : {}),
      }),
    );
    await renderList({ list: runtimeList(hosts) });
    const shown = () =>
      screen
        .getAllByTestId("runtime-row")
        .filter((row) => row.style.display !== "none")
        .map((row) => row.querySelector("a")?.textContent);
    const pager = screen.getByRole("navigation", { name: "Runtimes pages" });
    const rowsPager = pager.closest("[data-rows-pager]");
    const range = () => rowsPager?.querySelector("[data-range]")?.textContent;
    expect(range()).toBe("1–10 of 12");
    expect(shown()).toHaveLength(10);
    fireEvent.click(within(pager).getByRole("button", { name: "Next page" }));
    expect(range()).toBe("11–12 of 12");
    expect(shown()).toEqual(["host-10", "host-11"]);

    await userEvent.click(screen.getByRole("combobox", { name: "Rows" }));
    await userEvent.click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() => {
      expect(shown()).toHaveLength(12);
    });

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search this list" }),
      { target: { value: "HOST-07" } },
    );
    expect(shown()).toEqual(["host-07"]);
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search this list" }),
      { target: { value: "nothing like this" } },
    );
    expect(screen.getByText("No rows match.")).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search this list" }),
      { target: { value: "" } },
    );

    // Health reads two values over twelve rows, so the design's rule offers
    // it. Kind reads not recorded on every row and offers nothing.
    const user = userEvent.setup();
    const health = screen.getByRole("combobox", { name: "Filter by Health" });
    expect(await optionNames(user, health)).toEqual([
      "All (Health)",
      "not enrolled",
      "not recorded",
    ]);
    expect(
      screen.queryByRole("combobox", { name: "Filter by Kind" }),
    ).toBeNull();
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Filter by Health" }),
      "not enrolled",
    );
    expect(shown()).toEqual(["host-03"]);
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Filter by Health" }),
      "All (Health)",
    );

    const runtime = screen.getByRole("columnheader", { name: "Runtime" });
    fireEvent.click(within(runtime).getByRole("button"));
    expect(runtime).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(runtime).getByRole("button"));
    expect(runtime).toHaveAttribute("aria-sort", "descending");
    expect(shown()[0]).toBe("host-11");
  });
});

describe("Runtimes tab, not loaded", () => {
  it("shows the empty state with the spec's copy, Add a runtime in the default style and the CLI path", async () => {
    await renderList({ list: runtimeList([]) });
    const empty = screen.getByTestId("runtimes-empty");
    expect(
      within(empty).getByRole("heading", { name: "No runtime is enrolled" }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "Until a host enrolls, an agent has an identity and a toolbelt but no installed hook. Its runs are graded observe.",
    );
    // Connect an agent in the Agents page header is the page's one gold
    // action, so the empty state's Add a runtime is not gold.
    const add = within(empty).getByTestId("runtimes-add");
    expect(add).toHaveTextContent("Add a runtime");
    expect(add).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.getAllByTestId("runtimes-add")).toEqual([add]);
    expect(goldButtons()).toEqual([]);
    fireEvent.click(
      within(empty).getByRole("button", { name: "Enroll from the CLI" }),
    );
    const dialog = await screen.findByTestId("runtimes-cli-dialog");
    expect(dialog).toHaveTextContent("oxagen agent enroll");
    // The command needs the CLI on the host, and the app is what installs it.
    expect(
      within(dialog).getByRole("link", { name: "Intel (.dmg)" }),
    ).toHaveAttribute(
      "href",
      "https://downloads.oxagen.sh/latest/Oxagen_x64.dmg",
    );
    expect(dialog).toHaveTextContent(
      "Nothing on this page installs a hook. Enrollment runs on the host itself.",
    );
  });

  it("replaces the body with the error state and its trace line", async () => {
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
      "policy not recorded",
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

  it("draws the skeleton as a panel of seven rows", () => {
    render(
      <IntlProvider>
        <RuntimesLoading />
      </IntlProvider>,
    );
    const loading = screen.getByTestId("runtimes-loading");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Reading the runtimes of this workspace");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(loading.querySelectorAll("[data-skeleton-tile]")).toHaveLength(0);
    expect(loading.querySelectorAll("[data-skeleton-row]")).toHaveLength(7);
    // Every bone is the design's shimmer, as on every other page.
    expect(loading.querySelectorAll(".skeleton")).toHaveLength(8);
    expect(loading.querySelector(".animate-pulse")).toBeNull();
  });
});
describe("One runtime, in the drawer", () => {
  it("opens the host over the tab: the host facts in the spec's order, the agents and the rollback", async () => {
    const calls = await renderDetail({ list: runtimeList([enrollment()]) });
    expect(calls.agents).toEqual([["acme.core.release-manager"]]);
    // The drawer is a dialog named for the host; the tab stays behind it, so
    // there is no back link and no second page header.
    expect(screen.getByRole("dialog", { name: "mbell-mbp-16" })).toBeVisible();
    expect(screen.queryByTestId("runtime-back")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const host = screen.getByRole("region", { name: "mbell-mbp-16" });
    const subtitle = screen.getByTestId("runtime-subtitle");
    expect(
      within(subtitle)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "kind not recorded",
      "macOS 15.6 · arm64",
      "Started by not recorded",
    ]);
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
    expect(screen.getByTestId("fact-harness")).toHaveTextContent(
      "Claude Code 2.1.4 at enrollment",
    );
    expect(screen.getByTestId("fact-collector")).toHaveTextContent(
      "tachod 1.6.2telemetry gaps in the last 24h not recorded",
    );
    expect(screen.getByTestId("fact-hook-binary")).toHaveTextContent(
      "tacho-hook 1.6.2 (fails closed against its cached bundle)",
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
    expect(
      row.querySelector("[data-harness-badge] [data-harness-mark]"),
    ).toHaveAttribute("data-harness-mark", "claude-code");
    // The design's agent card names the harness under the key.
    expect(nth(within(row).getAllByRole("cell"), 0, "cell")).toHaveTextContent(
      "acme.core.release-managerClaude Code",
    );
    expect(
      within(agents).getByRole("navigation", {
        name: "Agents on this host pages",
      }),
    ).toBeInTheDocument();
    expect(
      agents.querySelector("[data-rows-pager] [data-range]")?.textContent,
    ).toBe("1–1 of 1");
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
      "Every agent on this host shares its hooks and earns the same tier. Each keeps its own identity, steering, and toolbelt.",
    );

    const rollback = screen.getByRole("region", { name: "Rollback" });
    expect(screen.getByTestId("runtime-unenroll-command")).toHaveTextContent(
      "oxagen agent unenroll release-manager \\ --host tch_mbellmbp16aaaaaaaaaaaaa",
    );
    expect(rollback).toHaveTextContent(
      "If hooks are stripped by hand instead, the next run records hooks_removed and the tier falls to observe. A recorded tier does not change later.",
    );
    expect(
      within(rollback).getByRole("button", { name: "Run a smoke session" }),
    ).toBeInTheDocument();
    expect(
      within(rollback).getByRole("button", { name: "Unenroll" }),
    ).toBeInTheDocument();
    // Connect an agent in the page header stays the one gold action.
    expect(goldButtons()).toEqual([]);
  });

  it("closes back to the Runtimes tab, keeping the scroll where it is", async () => {
    await renderDetail({ list: runtimeList([enrollment()]) });
    fireEvent.click(screen.getByRole("button", { name: "Close mbell-mbp-16" }));
    expect(replace).toHaveBeenCalledWith(
      "/acme/core-platform/agents?tab=runtimes",
      { scroll: false },
    );
  });

  it("names a shadowing settings file and a harness this build does not know", async () => {
    await renderDetail({
      list: runtimeList([
        enrollment({
          harnesses: ["codex", "acme-bot"],
          modelRoute: "direct",
          shadowedBy: "/etc/managed-settings.json",
        }),
      ]),
    });
    const harness = screen.getByTestId("fact-harness");
    expect(harness).toHaveTextContent("Codex CLI version not recorded");
    expect(harness).toHaveTextContent("acme-bot version not recorded");
    // Enrollment records Claude Code's version alone (#3919).
    for (const version of harness.querySelectorAll("[data-not-backed]"))
      expect(version).toHaveAttribute("data-gap", "#3919");
    const surface = screen.getByTestId("fact-model-surface");
    expect(surface).toHaveTextContent("provider direct");
    expect(surface).toHaveTextContent(
      "overridden by /etc/managed-settings.json",
    );
  });

  it("names Claude Code with no enrollment version as not recorded, never a blank", async () => {
    await renderDetail({
      list: runtimeList([enrollment({ claudeVersionAtEnroll: null })]),
    });
    const harness = screen.getByTestId("fact-harness");
    expect(harness).toHaveTextContent("Claude Code version not recorded");
    expect(harness.querySelector("[data-not-backed]")).toHaveAttribute(
      "data-gap",
      "#3919",
    );
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

  it("draws the operator's avatar from the roster in the hover card", async () => {
    await renderDetail({
      list: runtimeList([enrollment()]),
      members: memberList([
        {
          id: "usr_marcusbell",
          name: "Marcus Bell",
          email: "marcus@acme.test",
          avatarUrl: "https://avatars.example.com/marcus.png",
          role: "owner",
          joinedAt: "2026-01-05T09:00:00.000Z",
        },
      ]),
    });
    fireEvent.mouseEnter(screen.getByTestId("runtime-operator"));
    expect(
      screen
        .getByTestId("operator-card")
        .querySelector('[data-avatar="image"]'),
    ).toHaveAttribute("src", "https://avatars.example.com/marcus.png");
  });

  it("lists the five command hooks when the collector read them back", async () => {
    await renderDetail({
      list: runtimeList([enrollment({ hooksOk: true })]),
    });
    const written = screen.getByTestId("fact-hooks-written");
    expect(written).toHaveTextContent(
      "SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, StopFive run as command hooks. The first four can refuse.",
    );
    expect(written.querySelector("[data-not-backed]")).toBeNull();
  });

  it("names the hooks written not recorded when the read-back found a gap or the host runs more than Claude Code (negative)", async () => {
    for (const host of [
      enrollment({ hooksOk: false }),
      enrollment({ hooksOk: true, harnesses: ["claude-code", "codex"] }),
    ]) {
      await renderDetail({ list: runtimeList([host]) });
      const written = screen.getByTestId("fact-hooks-written");
      expect(written).not.toHaveTextContent("SessionStart");
      expect(written.querySelector("[data-not-backed]")).toHaveAttribute(
        "data-gap",
        "#3818",
      );
      cleanup();
    }
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
      "loopback proxy and provider directsome harness configs name the loopback proxy and others go straight to the provider",
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
      "allows on a stale bundle in observe mode",
    );
    expect(screen.getByTestId("fact-model-surface")).toHaveTextContent(
      "model traffic goes from the harness straight to its provider",
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

  it("says the workspace holds no runtime with an id it does not hold, in the drawer (negative)", async () => {
    await renderDetail(
      { list: runtimeList([enrollment()]) },
      "tch_nosuchaaaaaaaaaaaaaaaa",
    );
    expect(screen.getByRole("dialog", { name: "Runtime" })).toBeVisible();
    expect(screen.getByTestId("runtime-missing")).toHaveTextContent(
      "This workspace holds no runtime with that id. It may have been unenrolled.",
    );
    expect(screen.queryByRole("region", { name: "Rollback" })).toBeNull();
  });

  it("opens the drawer on the error and denied states", async () => {
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

  it("unenrolls behind a confirming dialog and re-reads the tab", async () => {
    unenrollRuntime.mockResolvedValue({
      ok: true,
      value: { revokedAt: "2026-09-23T10:00:00.000Z" },
    });
    await renderDetail({ list: runtimeList([enrollment()]) });
    fireEvent.click(screen.getByRole("button", { name: "Unenroll" }));
    const dialog = await screen.findByTestId("runtime-unenroll-dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Unenroll mbell-mbp-16" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "Calls routed through Oxagen are refused from this host from now on. The hooks stay on the host until the rollback command runs there",
    );
    expect(screen.getByTestId("runtime-unenroll-warn")).toHaveTextContent(
      "This revokes the enrollment of acme.core.release-manager on this machine.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Keep runtime" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unenroll runtime" }),
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
      "Your roles do not let you unenroll a host. An organization or workspace Owner or Admin can. Nothing was changed.",
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
        within(dialog).getByRole("button", { name: "Unenroll runtime" }),
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
      within(dialog).getByRole("button", { name: "Unenroll runtime" }),
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
  // runtimes.md, Mobile: touch targets are 44 px or larger.
  it("keeps the row links and every control a 44px touch target", async () => {
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
    } finally {
      phone.restore();
    }
  });

  it("makes the agent row's link a 44px target that opens the agent from the whole row", async () => {
    const phone = phoneWidth();
    try {
      await renderDetail({ list: runtimeList([enrollment()]) });
      const row = screen.getByTestId("runtime-agent-row");
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

describe("Add a runtime (ADR-198)", () => {
  it("fills the slug from the name, dropping apostrophes, until the slug is edited", async () => {
    const dialog = await openAddRuntime();
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Mac's Laptop" },
    });
    expect(within(dialog).getByLabelText("Slug")).toHaveValue("macs-laptop");
    fireEvent.change(within(dialog).getByLabelText("Slug"), {
      target: { value: "laptop-one" },
    });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Mac's Laptop 2" },
    });
    expect(within(dialog).getByLabelText("Slug")).toHaveValue("laptop-one");
  });

  it("names the runtime and goes straight on to registering its agent", async () => {
    createRuntime.mockResolvedValue({
      ok: true,
      value: {
        id: "rtm_macslaptop",
        name: "Mac's Laptop",
        slug: "macs-laptop",
        register: "/acme/core-platform/register/name?runtime=rtm_macslaptop",
      },
    });
    const dialog = await openAddRuntime();
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Mac's Laptop" },
    });
    fireEvent.click(within(dialog).getByTestId("runtimes-add-submit"));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/acme/core-platform/register/name?runtime=rtm_macslaptop",
      );
    });
    expect(createRuntime).toHaveBeenCalledWith("acme", "core-platform", {
      name: "Mac's Laptop",
      slug: "macs-laptop",
    });
  });

  it("names a taken slug on the Slug field and writes nothing else (negative)", async () => {
    createRuntime.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "runtime_slug_taken",
    });
    const dialog = await openAddRuntime();
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "GPU box" },
    });
    fireEvent.click(within(dialog).getByTestId("runtimes-add-submit"));
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Slug")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
    expect(within(dialog).getByLabelText("Slug")).toHaveAccessibleDescription(
      /Another runtime in this workspace has this slug/,
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("asks for the contained launcher only when the person ticks it (ADR-204)", async () => {
    createRuntime.mockResolvedValue({
      ok: true,
      value: {
        id: "rtm_gpubox",
        name: "GPU box",
        slug: "gpu-box",
        register: "/acme/core-platform/register/name?runtime=rtm_gpubox",
      },
    });
    const dialog = await openAddRuntime();
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "GPU box" },
    });
    const contained = within(dialog).getByRole("checkbox", {
      name: "Require the contained launcher",
    });
    expect(contained).not.toBeChecked();
    expect(contained).toHaveAccessibleDescription(
      "Every agent on this runtime then runs only under the contained launcher. You can change this later on the Runtimes tab.",
    );
    fireEvent.click(contained);
    expect(contained).toBeChecked();
    fireEvent.click(within(dialog).getByTestId("runtimes-add-submit"));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/acme/core-platform/register/name?runtime=rtm_gpubox",
      );
    });
    expect(createRuntime).toHaveBeenCalledWith("acme", "core-platform", {
      name: "GPU box",
      slug: "gpu-box",
      containmentRequired: true,
    });
  });

  it("refuses an empty name without calling the write (negative)", async () => {
    const dialog = await openAddRuntime();
    fireEvent.click(within(dialog).getByTestId("runtimes-add-submit"));
    expect(await within(dialog).findByText("Name the runtime.")).toBeVisible();
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

describe("A named runtime's drawer and its containment (ADR-204)", () => {
  /** One named runtime in the drawer, for the owner unless another viewer is given. */
  async function renderNamed(runtime = namedRuntime(), viewer = ctx) {
    await renderDetail(
      {
        list: runtimeList([enrollment()]),
        named: namedRuntimeList([runtime]),
      },
      runtime.id,
      viewer,
    );
  }

  const containmentSwitch = () =>
    screen.getByRole("switch", { name: "Require the contained launcher" });

  it("draws the runtime's facts and, for an owner, the Containment switch", async () => {
    await renderNamed();
    expect(screen.getByRole("dialog", { name: "Mac's laptop" })).toBeVisible();
    const facts = screen.getByRole("region", { name: "Mac's laptop" });
    expect(
      within(facts)
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual(["Slug", "Agents", "Live hosts", "Last seen"]);
    expect(screen.getByTestId("fact-slug")).toHaveTextContent("macs-laptop");
    expect(screen.getByTestId("fact-agents")).toHaveTextContent(
      "mac-claudeClaude Code",
    );
    expect(screen.getByTestId("fact-live-hosts")).toHaveTextContent(/^1$/);
    expect(
      screen.getByTestId("fact-last-seen").querySelector("time"),
    ).toHaveAttribute("datetime", "2026-09-23T09:12:44.000Z");

    const containment = screen.getByRole("region", { name: "Containment" });
    expect(containment).toHaveTextContent(
      "When containment is required, every agent on this runtime runs only under the contained launcher, including agents registered later.",
    );
    expect(containment).toHaveTextContent(
      "A change reaches each host on its next bundle fetch.",
    );
    const toggle = within(containment).getByRole("switch", {
      name: "Require the contained launcher",
    });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription("Not required");
    // The host drawer's panels belong to an enrollment, not to a named runtime.
    expect(screen.queryByRole("region", { name: "Rollback" })).toBeNull();
    expect(setRuntimeContainment).not.toHaveBeenCalled();
  });

  it("requires the contained launcher through update_runtime and reads the tab again", async () => {
    setRuntimeContainment.mockResolvedValue({
      ok: true,
      value: { containmentRequired: true },
    });
    await renderNamed();
    fireEvent.click(containmentSwitch());
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(setRuntimeContainment).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rtm_macslaptop",
      true,
    );
    expect(screen.queryByTestId("runtime-containment-failure")).toBeNull();
  });

  it("turns a required containment off by sending false", async () => {
    setRuntimeContainment.mockResolvedValue({
      ok: true,
      value: { containmentRequired: false },
    });
    await renderNamed(namedRuntime({ containmentRequired: true }));
    const toggle = containmentSwitch();
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription("Required");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(setRuntimeContainment).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rtm_macslaptop",
      false,
    );
  });

  it("names a refusal and leaves the switch where the record has it (negative)", async () => {
    setRuntimeContainment.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    await renderNamed();
    fireEvent.click(containmentSwitch());
    expect(
      await screen.findByTestId("runtime-containment-failure"),
    ).toHaveTextContent(
      "Your roles do not let you change containment. An organization or workspace Owner or Admin can. Nothing was changed.",
    );
    expect(containmentSwitch()).not.toBeChecked();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says a runtime that is gone no longer exists (negative)", async () => {
    setRuntimeContainment.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "runtime_not_found",
    });
    await renderNamed();
    fireEvent.click(containmentSwitch());
    expect(
      await screen.findByTestId("runtime-containment-failure"),
    ).toHaveTextContent("This runtime no longer exists. Nothing was changed.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("names a write that never answered (negative)", async () => {
    setRuntimeContainment.mockRejectedValue(new Error("network down"));
    await renderNamed();
    fireEvent.click(containmentSwitch());
    expect(
      await screen.findByTestId("runtime-containment-failure"),
    ).toHaveTextContent(
      "This write could not be answered: action_failed. Nothing was changed.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a member the value read-only, with no switch and no Add a runtime (negative)", async () => {
    await renderNamed(namedRuntime({ containmentRequired: true }), memberCtx);
    const containment = screen.getByRole("region", { name: "Containment" });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(within(containment).getByRole("term")).toHaveTextContent(
      "Contained launcher",
    );
    const value = screen.getByTestId("runtime-containment-value");
    expect(value).toHaveTextContent(/^Required/);
    expect(value).toHaveTextContent(
      "An organization or workspace Owner or Admin can change it.",
    );
    expect(screen.queryByTestId("runtimes-add")).toBeNull();
    cleanup();
    await renderNamed(namedRuntime(), memberCtx);
    expect(screen.getByTestId("runtime-containment-value")).toHaveTextContent(
      /^Not required/,
    );
  });


  it("says the workspace holds no named runtime with an id it does not hold (negative)", async () => {
    await renderDetail(
      { list: runtimeList([enrollment()]), named: namedRuntimeList() },
      "rtm_nosuchruntime",
    );
    expect(screen.getByTestId("runtime-missing")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("reads the one runtime by its id, so a runtime past the list's 500 cap still opens", async () => {
    const calls = await renderDetail(
      { list: runtimeList([enrollment()]), named: namedRuntimeList() },
      "rtm_macslaptop",
    );
    expect(calls.named).toEqual(["rtm_macslaptop"]);
    expect(screen.getByRole("region", { name: "Containment" })).toBeVisible();
  });

  it("reads nothing for a malformed runtime id and says no runtime has it (negative)", async () => {
    const calls = await renderDetail(
      { list: runtimeList([enrollment()]), named: namedRuntimeList() },
      "rtm_Not-An-Id",
    );
    expect(calls.named).toEqual([]);
    expect(screen.getByTestId("runtime-missing")).toBeInTheDocument();
  });

  it("opens the drawer on the error state when the runtimes read fails (negative)", async () => {
    await renderDetail(
      {
        list: runtimeList([enrollment()]),
        named: readError("runtimes_unavailable", 503),
      },
      "rtm_macslaptop",
    );
    expect(screen.getByTestId("runtimes-error")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("keeps the switch's row a 44px touch target on a phone", async () => {
    const phone = phoneWidth();
    try {
      await renderNamed();
      const label = screen
        .getByRole("switch", { name: "Require the contained launcher" })
        .closest("label");
      if (label === null) throw new Error("the switch has no label");
      expect(label).toHaveAttribute("data-touch-target");
      expect(getComputedStyle(label).minHeight).toBe("44px");
    } finally {
      phone.restore();
    }
  });
});
