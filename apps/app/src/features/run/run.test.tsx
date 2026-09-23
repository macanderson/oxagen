// @vitest-environment jsdom
// The Run page over a fake DataSource: the header, the tab chooser, and each
// of the four sections in its ok, empty, denied and error states, with an axe
// check on every render.
//
// Two rules the tests hold the page to, because breaking either is how a
// console starts lying: a tab's own heavy read (the chain, the cost ledger,
// the frames page) happens only when that tab is open, and a value the
// contract did not carry reads "not recorded" rather than a zero.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  NOW,
  runChain,
  runCost,
  runDetail,
  runFrame,
  runFrameBody,
  runOutputNode,
  runOutputs,
  runRow,
  mockupTranscript,
  runSource,
  runTranscript,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";

const notFound = vi.fn();
const refresh = vi.fn();
// jsdom has no layout, so it has no scrollIntoView; playback calls it.
Element.prototype.scrollIntoView = vi.fn();
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  notFound: () => {
    notFound();
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return { getTranslations: (namespace?: string) => translator(namespace) };
});
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Run } = await import("./run");
const { RunLoading } = await import("./loading");

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

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "run.read",
} as const;
const DOWN = readError("frame_store_unreachable", 502);

/** The same workspace seen by an organization Member: `export_run` refuses this role. */
const memberCtx = unsafeMint(WsCtx, {
  userId: "usr_priyanair",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** An organization Viewer who is only a workspace Viewer: every run write refuses this pair. */
const viewerCtx = unsafeMint(WsCtx, {
  userId: "usr_leowatts",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "viewer",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "viewer",
});

async function renderRun(
  reads: Parameters<typeof runSource>[0],
  view: {
    tab?: string;
    zoom?: string;
    kinds?: string;
    frames?: string;
    body?: string;
    reads?: string;
    spine?: string;
    viewer?: typeof ctx;
  } = {},
) {
  const { source, calls } = runSource(reads);
  const element = await Run({
    ctx: view.viewer ?? ctx,
    source,
    runId: "tse_7k2m9q",
    tab: view.tab ?? null,
    zoom: view.zoom ?? null,
    kinds: view.kinds ?? null,
    frames: view.frames ?? null,
    body: view.body ?? null,
    reads: view.reads ?? null,
    spine: view.spine ?? null,
    now: NOW,
  });
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
}

const ok = readOk;

afterEach(() => {
  cleanup();
  notFound.mockClear();
});

describe("header", () => {
  it("titles the when line with the generated name and draws the model's summary as generated", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-when")).toHaveTextContent(
      "Cut the 3.2 release branch",
    );
    // The eyebrow says Run and the h1 is the run id, in the feature's header.
    const header = within(screen.getByTestId("run-header"));
    expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "tse_7k2m9q",
    );
    expect(header.getByText("Run")).toBeTruthy();
    const panel = within(screen.getByTestId("run-summary"));
    expect(panel.getByRole("heading", { name: "Summary" })).toBeTruthy();
    expect(panel.getByText("generated · not the record")).toBeTruthy();
    expect(screen.getByTestId("generated-summary")).toHaveTextContent(
      "Cut release/3.2 from main",
    );
    expect(
      panel.getByText(/^generated by z-ai\/glm-flash-latest · /),
    ).toBeTruthy();
    expect(
      panel.getByRole("link", { name: "Check it against the frames" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript",
    );
    await expectNoAxe(container);
  });

  it("titles a run with its task reference when no generated name exists", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ name: null, summary: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-when")).toHaveTextContent(
      "ENG-4121 cut the 3.2 release",
    );
    expect(screen.queryByTestId("generated-summary")).toBeNull();
    expect(
      screen.getByText(/No summary yet\. Open the transcript/),
    ).toBeTruthy();
  });

  it("reads 'not recorded' for a figure the run does not carry, never a zero", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            cost: null,
            turns: null,
            sealedAt: null,
            replayGrade: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: null })),
    });
    const stats = within(screen.getByTestId("run-stats"));
    expect(stats.getAllByText("not recorded").length).toBeGreaterThanOrEqual(3);
    // A live run's wall clock reads against the page's clock, so far.
    expect(stats.getByText("so far")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("draws the agent, status and tier chips, and the rig the run ran on", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const chips = within(screen.getByTestId("run-chips"));
    expect(chips.getByTestId("run-tier")).toBeTruthy();
    expect(chips.getByTestId("run-task")).toHaveTextContent(
      "task ENG-4121 cut the 3.2 release",
    );
    const rig = within(screen.getByTestId("run-rig"));
    expect(rig.getByText("claude-sonnet-5")).toHaveAttribute(
      "title",
      "anthropic sonnet",
    );
    // The session recorded its harness, so the rig names it and its version.
    expect(rig.getByText("Claude Code")).toBeTruthy();
    expect(rig.getByText("2.1.0")).toBeTruthy();
    // Effort is read out of a request body the record does not keep (G6).
    const effort = rig.getByTestId("run-effort");
    expect(effort).toHaveTextContent("effort not captured");
    expect(effort).toHaveAttribute("data-gap", "G6");
    await expectNoAxe(container);
  });

  it("names the operator and the machine the run ran on, with a copy button for the host", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    // The operator is in the Summary panel's who-was-involved row.
    const involved = within(screen.getByTestId("run-involved"));
    expect(involved.getByText("Marcus Bell")).toBeTruthy();
    // The id is a key, not a label: it is in the hover card, never in the line.
    expect(involved.queryByText("prn_marcusbell")).toBeNull();
    await userEvent.hover(involved.getByTestId("run-operator-name"));
    expect(involved.getByTestId("operator-card")).toHaveTextContent(
      "prn_marcusbell",
    );
    // The when line is the task and the times, and names no operator.
    expect(screen.getByTestId("run-when")).not.toHaveTextContent("Marcus Bell");
    const checkout = within(screen.getByTestId("run-checkout"));
    expect(checkout.getByText("repository not captured")).toBeTruthy();
    expect(checkout.getByText("branch not captured")).toBeTruthy();
    expect(checkout.getByText("mac-studio.local")).toBeTruthy();
    expect(checkout.getByRole("button", { name: /Copy/ })).toBeTruthy();
    expect(checkout.getByText("path not captured")).toBeTruthy();
    // No path is shown, so nothing is marked derived.
    expect(checkout.queryByText("derived")).toBeNull();
    const machine = screen.getByTestId("run-machine");
    expect(machine.getAttribute("title")).toContain(
      "Session machine facts not recorded.",
    );
    expect(machine.getAttribute("title")).toContain(
      "Enrollment hostname and facts: darwin · 15.6 · arm64 · v24.4.0",
    );
    await expectNoAxe(container);
  });

  it("labels session host observations separately from enrollment facts", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            machine: {
              hostname: "old-host",
              platform: "darwin",
              osVersion: "15.6",
              arch: "arm64",
              nodeVersion: "v24.4.0",
              recorded: {
                platform: "linux",
                osVersion: "6.12",
                arch: "x64",
                recordedAt: "2026-09-20T00:00:00Z",
                eventHash: `sha256:${"a".repeat(64)}`,
              },
            },
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    const title = screen.getByTestId("run-machine").getAttribute("title");
    expect(title).toContain("Recorded in this session: linux · 6.12 · x64");
    expect(title).toContain(
      "Enrollment hostname and facts: darwin · 15.6 · arm64 · v24.4.0",
    );
    expect(title).not.toContain("Session machine facts not recorded.");
  });

  it("reads a model and a machine the run does not carry as not recorded, never a placeholder", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            source: "ledger",
            model: null,
            machine: null,
            harness: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    const rig = within(screen.getByTestId("run-rig"));
    expect(rig.getByText("model not recorded")).toBeTruthy();
    // No session harness and a denied agent read: the harness is not guessed.
    expect(rig.getByText("harness not recorded")).toBeTruthy();
    expect(
      within(screen.getByTestId("run-checkout")).getByText(
        "The evidence ledger records no host for a run.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("run-machine")).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("says a run an agent started has no person to name, and does not borrow one", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ operatorKind: "agent", operatorName: null }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    const operator = within(screen.getByTestId("run-operator"));
    expect(operator.getByText("An agent, not a person")).toBeTruthy();
    expect(operator.queryByText("Marcus Bell")).toBeNull();
  });

  it("separates a person with no name recorded from a run with no operator at all", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ operatorKind: "human", operatorName: null }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(
      within(screen.getByTestId("run-operator")).getByText(
        "A person, name not recorded",
      ),
    ).toBeTruthy();
    cleanup();
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            operatorId: null,
            operatorKind: null,
            operatorName: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    const operator = screen.getByTestId("run-operator");
    expect(operator).not.toHaveTextContent("A person, name not recorded");
    expect(operator).toHaveTextContent("not recordedoperator");
  });

  it("draws the pause banner only while ingress is paused", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ ingressPaused: true }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-paused")).toHaveTextContent(
      "Ingress is paused",
    );
    cleanup();
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-paused")).toBeNull();
  });

  it("reads the operator id when the record holds neither a name nor a kind", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            operatorId: "prn_unknown_kind",
            operatorKind: null,
            operatorName: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-operator-name")).toHaveTextContent(
      /^prn_unknown_kind$/,
    );
    expect(screen.getByTestId("run-operator")).not.toHaveTextContent(
      "not recorded",
    );
  });

  it("names the operator on the started line with its hover card", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const operator = screen.getByTestId("run-operator-name");
    expect(operator).toHaveTextContent(/^Marcus Bell$/);
    expect(operator.getAttribute("data-operator-id")).toBe("prn_marcusbell");
  });

  it("omits witness details from the operator view", async () => {
    await renderRun({
      detail: ok(runDetail({ witnessed: true })),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-witnessed")).toBeNull();
  });
});

describe("controls", () => {
  it("draws pause, resume, steer and cancel on a live wrapped run", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ status: "live" }) })),
      transcript: ok(runTranscript()),
    });
    for (const command of ["pause", "resume", "steer", "cancel"]) {
      expect(screen.getByTestId(`run-${command}`)).not.toBeDisabled();
    }
  });

  it("allows ledger ingress control and explains the remaining control limit", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", source: "ledger" }) }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-pause")).toBeEnabled();
    expect(screen.queryByTestId("run-resume")).toBeNull();
    expect(screen.getByTestId("run-steer")).toBeDisabled();
    expect(screen.getByTestId("run-cancel")).toBeEnabled();
    expect(screen.getByTestId("ledger-control-limit")).toHaveTextContent(
      "Cancel revokes",
    );
  });

  it("disables every control on a live run for a viewer neither role admits, and says why (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail({ run: runRow({ status: "live" }) })),
        transcript: ok(runTranscript()),
      },
      { viewer: viewerCtx },
    );
    expect(screen.getByTestId("run-steer")).toBeDisabled();
    expect(screen.getByTestId("role-no-control")).toBeTruthy();
  });

  it("offers no control on a sealed run, and offers the record writes instead", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-pause")).toBeNull();
    // An ended run offers Fork replay and Bisect, then Export, in that order.
    const actions = within(screen.getByTestId("run-actions"));
    const labels = actions
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual(["Fork replay", "Bisect", "Export"]);
    // Summarize again lives in the Summary panel, not in the header.
    expect(
      within(screen.getByTestId("run-summary")).getByTestId("run-resummarize"),
    ).toBeTruthy();
  });

  it("orders a live run's actions as Pause, Resume, Steer, Cancel and then Export, disabled until the seal", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", sealedAt: null }) }),
      ),
      transcript: ok(runTranscript()),
    });
    const actions = within(screen.getByTestId("run-actions"));
    expect(
      actions.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["❙❙Pause run", "▶Resume run", "Steer", "Cancel", "Export"]);
    const exported = actions.getByTestId("run-export");
    expect(exported).toBeDisabled();
    expect(exported).toHaveAttribute(
      "title",
      "Export signs a finished record. It opens once the run seals.",
    );
  });

  it("offers Summarize on a sealed run that has none", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ name: null, summary: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-summarize")).toBeTruthy();
  });

  it("draws Export disabled for an organization Member and says which role it needs (negative)", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { viewer: memberCtx },
    );
    expect(screen.getByTestId("run-export")).toBeDisabled();
    expect(screen.getByTestId("run-export").getAttribute("title")).toContain(
      "Owner or Admin role",
    );
    expect(screen.getByTestId("run-resummarize")).not.toBeDisabled();
    await expectNoAxe(container);
  });

  it("draws both record writes disabled for an organization Viewer (negative)", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { viewer: viewerCtx },
    );
    expect(screen.getByTestId("run-resummarize")).toBeDisabled();
    expect(screen.getByTestId("summarize-no-role")).toBeTruthy();
    expect(screen.getByTestId("run-export")).toBeDisabled();
  });

  it("offers Export to an Owner with no reason attached", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-export")).not.toBeDisabled();
    expect(screen.getByTestId("run-export")).not.toHaveAttribute("title");
  });
});

describe("the outputs spine", () => {
  it("is read with the page and drawn in the side column on every tab", async () => {
    const { container, calls } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        outputs: ok(runOutputs([runOutputNode({ name: "src/cut.ts" })])),
      },
      // Not the Transcript tab: the spine is not one tab's section, so opening
      // Governed actions must not take it away.
      { tab: "actions" },
    );
    expect(calls.outputs).toEqual([[ctx, "tse_7k2m9q"]]);
    const work = screen.getByRole("complementary", { name: "The work" });
    const spine = within(work).getByTestId("run-outputs");
    expect(spine).toHaveTextContent("src/cut.ts");
    const tabs = screen.getByRole("tablist", { name: "Run sections" });
    // `DOCUMENT_POSITION_FOLLOWING` is 4: the side column follows the main
    // column, so a phone reads the tabs first.
    expect(tabs.compareDocumentPosition(work) & 4).toBe(4);
    await expectNoAxe(container);
  });

  it("folds an outputs read that throws to the run's read error, and the page still renders", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      outputs: () => Promise.reject(new Error("outputs store down")),
    });
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(
      screen.getByText(/Outputs could not be loaded.*frame_store_unreachable/),
    ).toBeTruthy();
  });
});

describe("tabs", () => {
  it("opens Transcript by default and reads the whole-run transcript once", async () => {
    const { calls } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
    // The stat row, the tab counts, Policy, Context and the Transcript tab
    // share one read.
    expect(calls.transcript).toEqual([
      [ctx, "tse_7k2m9q", "everything", { kinds: [] }],
    ]);
    expect(calls.cost).toHaveLength(1);
    expect(calls.chain).toHaveLength(0);
  });

  it("reads every frame once and opens it at Steps when the zoom is not a level (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { zoom: "everything-else" },
    );
    expect(calls.transcript[0]).toEqual([
      ctx,
      "tse_7k2m9q",
      "everything",
      { kinds: [] },
    ]);
    expect(screen.getByRole("button", { name: "Steps" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens the transcript at the level the URL asked for, from the same read", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { zoom: "turns" },
    );
    expect(calls.transcript[0]).toEqual([
      ctx,
      "tse_7k2m9q",
      "everything",
      { kinds: [] },
    ]);
    expect(screen.getByRole("button", { name: "Turns" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens Transcript for a tab that is not a section (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "witness" },
    );
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(calls.chain).toHaveLength(0);
  });

  it("lands the retired proof, dod and ladder links on Cost", async () => {
    for (const tab of ["proof", "dod", "ladder"]) {
      cleanup();
      await renderRun(
        { detail: ok(runDetail()), transcript: ok(runTranscript()) },
        { tab },
      );
      expect(screen.getByRole("tab", { name: /Cost/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
  });

  it("lists the seven tabs in the spec's order, each with its count", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const tabs = within(screen.getByRole("tablist", { name: "Run sections" }));
    expect(
      tabs.getAllByRole("tab").map((link) => link.getAttribute("href")),
    ).toEqual(
      ["transcript", "issues", "actions", "cost", "policy", "context", "chain"]
        .map((tab) => `/acme/core-platform/runs/tse_7k2m9q?tab=${tab}`)
        // The Transcript tab keeps the zoom it was opened at.
        .map((href, index) => (index === 0 ? `${href}&zoom=steps` : href)),
    );
    expect(tabs.getByRole("tab", { name: /Transcript/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      tabs.getAllByRole("tab").map((tab) => tab.getAttribute("aria-selected")),
    ).toEqual(["true", "false", "false", "false", "false", "false", "false"]);
    // Transcript counts the entries the whole-run read carried.
    expect(screen.getByTestId("run-tab-count-transcript")).toHaveTextContent(
      String(runTranscript().entries.length),
    );
    expect(screen.getByTestId("run-tab-count-issues")).toHaveTextContent("1");
    expect(screen.getByTestId("run-tab-count-actions")).toHaveTextContent("0");
    // Nothing is parked on this run, so no tab carries the dot.
    expect(screen.queryByTestId("run-tab-parked-actions")).toBeNull();
    expect(screen.getByTestId("run-tab-count-chain")).toHaveTextContent(
      "sealed",
    );
  });

  it("marks a count read from a transcript that stopped short as a floor", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript({ complete: false })),
    });
    expect(screen.getByTestId("run-tab-count-policy")).toHaveTextContent(/\+$/);
  });

  it("opens Governed actions for the retired frames and approvals tab names", async () => {
    for (const tab of ["frames", "approvals"]) {
      cleanup();
      await renderRun(
        { detail: ok(runDetail()), transcript: ok(runTranscript()) },
        { tab },
      );
      expect(
        screen.getByRole("tab", { name: /Governed actions/ }),
      ).toHaveAttribute("aria-selected", "true");
    }
  });
});

describe("transcript", () => {
  it("draws the run's start, then each turn with its prompt, its steps on a spine and the agent's reply", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript" },
    );
    const turns = screen.getAllByTestId("transcript-turn");
    expect(
      turns.map((turn) => turn.querySelector("summary")?.textContent),
    ).toEqual([
      expect.stringContaining("Run start"),
      expect.stringContaining("turn 1"),
      expect.stringContaining("turn 2"),
    ]);
    expect(turns[1]).toHaveTextContent("done");
    expect(turns[1]).toHaveTextContent("4 steps");
    expect(turns[1]).toHaveTextContent("seq 2 to 8");
    // What was asked sits above the turn it opened, outside the disclosure,
    // so a collapsed turn still shows it.
    const asked = screen.getByTestId("transcript-you");
    expect(turns[1]).not.toContainElement(asked);
    expect(asked.nextElementSibling).toBe(turns[1]);
    expect(asked).toHaveTextContent("Cut the 2026.9.2 release candidate.");
    expect(turns[1]).toContainElement(screen.getByTestId("transcript-agent"));
    expect(screen.getByTestId("transcript-agent")).toHaveTextContent(
      "Both failures predate the release scope.",
    );
    const nodes = screen
      .getAllByTestId("transcript-step")
      .map((step) => step.getAttribute("data-node"));
    // A step with nothing to read (a context assembly with no body, a model
    // call the recorder kept only a digest of) draws no row; the Frames tab
    // still has it. What is left is what the run did.
    expect(nodes).toEqual(["control", "model", "tool", "control", "deny"]);
    await expectNoAxe(container);
  });

  it("puts the position at the head, marks the step holding it and reads the cost to that point", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript" },
    );
    const readout = screen.getByTestId("transport-readout");
    expect(readout).toHaveTextContent("seq 12");
    expect(readout).toHaveTextContent("/ 12");
    expect(readout).toHaveTextContent("0:24 / 0:24");
    expect(readout).toHaveTextContent("$0.90");
    const now = screen
      .getAllByTestId("transcript-step")
      .filter((step) => step.hasAttribute("data-now"));
    expect(now).toHaveLength(1);
    expect(now[0]).toHaveTextContent("create_tag");
    expect(screen.getByRole("button", { name: "Step forward" })).toBeDisabled();
    expect(
      within(screen.getByTestId("transcript")).getByText("sealed"),
    ).toBeTruthy();
    expect(screen.queryByText(/Replay grade fork/)).toBeNull();
  });

  it("scrubs back, dims the steps past the position and moves the cost with it", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript" },
    );
    fireEvent.change(screen.getByRole("slider", { name: "Scrub to frame" }), {
      target: { value: "4" },
    });
    const readout = screen.getByTestId("transport-readout");
    expect(readout).toHaveTextContent("seq 4");
    expect(readout).toHaveTextContent("$0.38");
    const steps = screen.getAllByTestId("transcript-step");
    const now = steps.find((step) => step.hasAttribute("data-now"));
    expect(now).toHaveTextContent("claude-fable-5-1");
    expect(steps[steps.length - 1]?.className).toContain("opacity-35");
    fireEvent.click(screen.getByRole("button", { name: "Step back" }));
    expect(readout).toHaveTextContent("seq 3");
  });

  it("opens every step's frames at Everything, and says a digest_only frame has nothing to read", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript", zoom: "everything" },
    );
    // Nine frames across the steps that have something to read; the frames
    // of the steps with nothing to read are the Frames tab's.
    expect(screen.getAllByTestId("transcript-frame")).toHaveLength(9);
    expect(screen.getByText('{"open":34}')).toBeTruthy();
    // The digest-only model call has no row, so nothing says it has no body.
    expect(screen.queryByText(/kept a digest and no body/)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Frame 7 on the Frames tab" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=7",
    );
  });

  it("closes everything at Turns and keeps the position", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript", zoom: "everything" },
    );
    fireEvent.click(screen.getByRole("button", { name: "Turns" }));
    expect(screen.queryAllByTestId("transcript-frame")).toHaveLength(0);
    expect(
      screen
        .getAllByTestId("transcript-turn")
        .every((turn) => !turn.hasAttribute("open")),
    ).toBe(true);
    expect(screen.getByTestId("transport-readout")).toHaveTextContent("seq 12");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&zoom=turns",
    );
    replaceState.mockRestore();
  });

  it("says which half a frame carried, and the decision a rule made about the call", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript", zoom: "everything" },
    );
    // A tool request is what went out; its call is what came back.
    const halves = screen
      .getAllByTestId("transcript-half")
      .map((half) => half.getAttribute("data-half"));
    expect(halves).toContain("Sent");
    expect(halves).toContain("Returned");
    const decisions = screen.getAllByTestId("entry-decision");
    expect(decisions[0]).toHaveTextContent("Decision: allow, at frame 6");
    expect(decisions[1]).toHaveTextContent("Decision: deny, at frame 12");
  });

  it("links a cut body to its frame's whole body on the Frames tab", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(
          runTranscript({
            entries: [
              transcriptEntry({
                seq: "37",
                response: transcriptBody({ seq: "37", truncated: true }),
              }),
            ],
          }),
        ),
      },
      { tab: "transcript", zoom: "everything" },
    );
    const note = screen.getByTestId("entry-truncated");
    expect(note).toHaveTextContent("Cut at the length one entry carries.");
    expect(
      within(note).getByRole("link", {
        name: "Read the whole body of frame 37",
      }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=37",
    );
  });

  it("follows a live run: a live badge, a running last turn, and a re-read every few seconds", async () => {
    vi.useFakeTimers();
    try {
      await renderRun(
        {
          detail: ok(runDetail({ run: runRow({ status: "live" }) })),
          transcript: ok(mockupTranscript()),
        },
        { tab: "transcript" },
      );
      expect(
        within(screen.getByTestId("transcript")).getByText("live"),
      ).toBeTruthy();
      expect(screen.getAllByTestId("transcript-turn")[2]).toHaveTextContent(
        "running",
      );
      expect(
        screen.getByText(/follows the run's head and reads what it records/),
      ).toBeTruthy();
      // Following is the view's own state: scrubbing back lets go of the head,
      // and "go live" takes it again. The frames themselves arrive over the
      // stream, which this environment has no EventSource for.
      fireEvent.change(screen.getByRole("slider", { name: "Scrub to frame" }), {
        target: { value: "2" },
      });
      expect(screen.getByTestId("transport-readout")).not.toHaveTextContent(
        "seq 12",
      );
      fireEvent.click(screen.getByRole("button", { name: "go live" }));
      expect(screen.getByTestId("transport-readout")).toHaveTextContent(
        "seq 12",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays from the start of a sealed run at the recorded pace", async () => {
    vi.useFakeTimers();
    try {
      await renderRun(
        { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
        { tab: "transcript" },
      );
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      const readout = screen.getByTestId("transport-readout");
      expect(readout).toHaveTextContent("seq 0");
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(readout).toHaveTextContent("seq 1");
      fireEvent.click(screen.getByRole("button", { name: "2×" }));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(readout).toHaveTextContent("seq 2");
      fireEvent.click(screen.getByRole("button", { name: "Pause playback" }));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(readout).toHaveTextContent("seq 2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a run with no frames has none (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ entries: [] })),
      },
      { tab: "transcript" },
    );
    expect(screen.getByText(/has no recorded frames yet/)).toBeTruthy();
  });

  it("says when the transcript stopped short of the end (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ complete: false })),
      },
      { tab: "transcript" },
    );
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "stops short of the end",
    );
  });

  it("says the transcript stopped short when entries lie past this read (negative)", async () => {
    // The ledger read reached the run's end, but the page did not: the cursor
    // is set, so drawing the page as the whole run would hide what is past it.
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ complete: true, cursor: "dDo0Mg" })),
      },
      { tab: "transcript" },
    );
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "More lie past this page",
    );
    expect(screen.getByTestId("transcript-more")).toBeTruthy();
  });

  it("names its own failure when the transcript read is refused (negative)", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: DENIED },
      { tab: "transcript" },
    );
    expect(
      screen.getByRole("region", { name: "Transcript" }),
    ).toHaveTextContent("Your roles do not include run.read");
  });
});

describe("frames", () => {
  it("draws a frame with its digest, stage, body reference and cost", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames" },
    );
    const [row] = screen.getAllByTestId("frame-row");
    expect(row).toHaveTextContent("model.call_completed");
    expect(row).toHaveTextContent("stage act");
    expect(row).toHaveTextContent("sha256:5f2d1c8a");
    expect(row).toHaveTextContent("bytes retained");
    await expectNoAxe(container);
  });

  it("names every redaction by its reason", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: {
              frames: [
                runFrame({
                  body: {
                    digest: "sha256:9a1b4e7c",
                    bytesRef: "blob://x",
                    fidelity: "full",
                    redactions: [
                      {
                        path: "bytes:12-60",
                        reason: "api key",
                        originalDigest: "sha256:cut",
                      },
                    ],
                  },
                }),
              ],
              cursor: null,
              more: false,
            },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames" },
    );
    expect(screen.getByTestId("frame-redactions")).toHaveTextContent(
      "removed bytes:12-60: api key",
    );
  });

  it("links to the next frame page when the page came back full with a cursor", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: { frames: [runFrame()], cursor: "ZjoyMA", more: true },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames" },
    );
    expect(screen.getByRole("link", { name: "Later frames" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&frames=ZjoyMA",
    );
  });

  it("links to no later page when the read carried a resume point but the page was short (negative)", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: { frames: [runFrame()], cursor: "ZjoyMA", more: false },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames" },
    );
    expect(screen.queryByRole("link", { name: "Later frames" })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Frame pages" }),
    ).toBeNull();
  });

  it("keeps the way back to the first frames on a later page that came back empty", async () => {
    const { container } = await renderRun(
      {
        detail: ok(
          runDetail({ frames: { frames: [], cursor: null, more: false } }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames", frames: "ZjoyMA" },
    );
    expect(screen.getByText(/Nothing lies past the frame/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "First frames" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions",
    );
    expect(screen.queryByRole("link", { name: "Later frames" })).toBeNull();
    await expectNoAxe(container);
  });

  it("passes the cursor the URL carried to get_run", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames", frames: "ZjoyMA" },
    );
    expect(calls.get[0]).toEqual([
      ctx,
      "tse_7k2m9q",
      { framesAfter: "ZjoyMA" },
    ]);
  });

  it("offers to open the body of a frame with retained bytes, and not of a digest_only one", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: {
              frames: [
                runFrame(),
                runFrame({
                  cursor: "ZjoxMg",
                  seq: "12",
                  body: {
                    digest: "sha256:0c1d",
                    bytesRef: null,
                    redactions: [],
                    fidelity: "digest_only",
                  },
                }),
              ],
              cursor: null,
              more: false,
            },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames", frames: "ZjoxMA" },
    );
    const links = screen.getAllByTestId("frame-open-body");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&frames=ZjoxMA&body=11",
    );
  });

  it("makes no body read when the URL opens no frame", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames" },
    );
    expect(calls.frameBody).toHaveLength(0);
    expect(screen.queryByTestId("frame-body")).toBeNull();
  });

  it("makes no body read for a value that is not a frame seq (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames", body: "../etc" },
    );
    expect(calls.frameBody).toHaveLength(0);
  });

  it("reads and draws the open frame's body as text, with its digest, type and size", async () => {
    const { calls, container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: ok(runFrameBody()),
      },
      { tab: "frames", frames: "ZjoxMA", body: "11" },
    );
    expect(calls.frameBody[0]).toEqual([ctx, "tse_7k2m9q", "11"]);
    const body = screen.getByTestId("frame-body");
    expect(body).toHaveTextContent("sha256:9a1b4e7c");
    expect(body).toHaveTextContent("application/json");
    expect(body).toHaveTextContent("92 bytes");
    expect(body).toHaveTextContent("Cut release/3.2 from main.");
    expect(screen.getByRole("region", { name: "Frame 11 body" })).toBeTruthy();
    expect(screen.getByTestId("frame-body-close")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&frames=ZjoxMA",
    );
    await expectNoAxe(container);
  });

  it("says a digest_only frame has no bytes to read rather than drawing an empty box (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: ok(
          runFrameBody({ contentType: null, text: null, bytes: null }),
        ),
      },
      { tab: "frames", body: "11" },
    );
    expect(screen.getByTestId("frame-body")).toHaveTextContent(
      "kept this frame's digest and no bytes",
    );
    expect(screen.getByTestId("frame-body")).toHaveTextContent(
      "no bytes retained",
    );
  });

  it("says retained bytes that are not text are not shown, and keeps their size (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: ok(
          runFrameBody({ contentType: "image/png", text: null, bytes: 4096 }),
        ),
      },
      { tab: "frames", body: "11" },
    );
    const body = screen.getByTestId("frame-body");
    expect(body).toHaveTextContent("not UTF-8 text");
    expect(body).toHaveTextContent("4,096 bytes");
  });

  it("names the body read's own failure and keeps the frames page beneath it (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: readError("not_found", 404),
      },
      { tab: "frames", body: "999" },
    );
    expect(
      screen.getByRole("region", { name: "Frame 999 body" }),
    ).toHaveTextContent("not_found");
    expect(screen.getAllByTestId("frame-row")).toHaveLength(1);
  });
});

describe("cost", () => {
  it("draws the rollup with its basis, its token classes and its price entries", async () => {
    const { container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        cost: ok(runCost()),
      },
      { tab: "cost" },
    );
    const panel = screen.getByRole("tabpanel");
    const headings = within(panel)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    // The spec's order: Model fit first, then Spend by area, Tool calls, the
    // Waterfall, Spend by token class and Prompt composition.
    expect(headings).toEqual([
      "Model fit",
      "Spend by area",
      "Tool calls",
      "Waterfall",
      "Spend by token class",
      "Prompt composition",
    ]);
    // Model fit names the gaps it waits on and offers no change.
    const fit = within(screen.getByTestId("run-model-fit"));
    expect(fit.getByText("generated · not the record")).toBeTruthy();
    expect(fit.queryByRole("button")).toBeNull();
    expect(
      screen.getByTestId("run-model-fit").querySelector('[data-gap="G14"]'),
    ).not.toBeNull();
    // The six instruments, with the cost's basis on the first.
    const instruments = screen.getAllByTestId("run-instrument");
    expect(instruments).toHaveLength(6);
    expect(instruments[0]).toHaveTextContent("gateway_observed");
    expect(instruments[2]).toHaveTextContent("113,328 in, 15,015 out");
    expect(instruments[3]).toHaveTextContent(
      "12 turns · 96 steps · 431 frames",
    );
    expect(panel).toHaveTextContent("prc_01k4qj9e");
    // Every class of §12.6, and a total that is the sum of the rows.
    expect(
      screen
        .getAllByTestId("cost-class-row")
        .map((row) => row.querySelector("td")?.textContent),
    ).toEqual([
      "input_uncached",
      "cache_read",
      "cache_write_5m",
      "cache_write_1h",
      "output",
      "reasoning",
    ]);
    expect(screen.getByTestId("cost-class-total")).toHaveTextContent("128,343");
    expect(screen.getByTestId("cost-family-row")).toHaveTextContent(
      "create_release",
    );
    // The split by area and prompt composition are not on the rollup (G3).
    expect(within(panel).getByTestId("run-spend-unsplit")).toHaveAttribute(
      "data-gap",
      "G3",
    );
    await expectNoAxe(container);
  });

  it("says the rollup has not run rather than printing zeros (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        cost: ok({ rollup: null }),
      },
      { tab: "cost" },
    );
    expect(screen.getByTestId("cost-not-rolled-up")).toHaveTextContent(
      "A zero here would be a measurement",
    );
    expect(screen.queryByTestId("run-instrument")).toBeNull();
    expect(screen.queryByTestId("cost-class-row")).toBeNull();
    // Model fit still leads the tab and names its gap.
    expect(screen.getByTestId("run-model-fit")).toBeTruthy();
  });
});

describe("failures", () => {
  it("is not found when the run is not in this workspace (negative)", async () => {
    await expect(
      renderRun({ detail: readError("run_not_found", 404) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("replaces the body with the error state: the code, what did not change, and Try again (negative)", async () => {
    const { container, calls } = await renderRun({ detail: DOWN });
    const state = within(screen.getByTestId("run-error"));
    expect(
      state.getByRole("heading", { name: "This run could not be loaded" }),
    ).toBeTruthy();
    expect(state.getByText("502 frame_store_unreachable")).toBeTruthy();
    expect(screen.getByTestId("run-error")).toHaveTextContent(
      "Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(state.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q",
    );
    expect(screen.getByTestId("run-error")).toHaveTextContent(/read at /);
    // The header, the tabs and the side column are not drawn over a failure.
    expect(screen.queryByTestId("run-header")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(calls.transcript).toHaveLength(0);
    await expectNoAxe(container);
  });

  it("replaces the body with the denied state, naming the permission and who decided (negative)", async () => {
    const { container } = await renderRun({ detail: DENIED });
    const state = within(screen.getByTestId("run-denied"));
    expect(
      state.getByRole("heading", { name: "You cannot see this run" }),
    ).toBeTruthy();
    expect(screen.getByTestId("run-denied")).toHaveTextContent(
      "Your roles on Acme Robotics do not include run.read on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(state.getByText("Signed in as")).toBeTruthy();
    expect(
      state.getByText("organization Owner · workspace Member · core-platform"),
    ).toBeTruthy();
    expect(state.getByText("Needed")).toBeTruthy();
    expect(state.getByText("Decided by")).toBeTruthy();
    expect(state.getByRole("link", { name: "Back to Fleet" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(screen.queryByTestId("run-header")).toBeNull();
    await expectNoAxe(container);
  });

  it("says an access request is waiting rather than drawing the page (negative)", async () => {
    await renderRun({
      detail: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "areq_01k4",
      },
    });
    expect(screen.getByTestId("run-pending")).toHaveTextContent(
      "Access request areq_01k4",
    );
  });

  it("replaces the body with the empty state for a run with no frames yet", async () => {
    const { container, calls } = await renderRun({
      detail: ok(runDetail({ run: runRow({ frames: 0, status: "live" }) })),
      transcript: ok(runTranscript()),
    });
    const state = within(screen.getByTestId("run-empty"));
    expect(
      state.getByRole("heading", { name: "This run has no frames yet" }),
    ).toBeTruthy();
    expect(screen.getByTestId("run-empty")).toHaveTextContent(
      "Oxagen minted a run token and the agent has not made its first model call. Nothing is wrong; a run with no frames has cost nothing and is not billable.",
    );
    expect(state.getByRole("link", { name: "Back to Fleet" })).toBeTruthy();
    expect(screen.queryByTestId("run-stats")).toBeNull();
    // An empty run is not read further: nothing was recorded to read.
    expect(calls.transcript).toHaveLength(0);
    expect(calls.cost).toHaveLength(0);
    await expectNoAxe(container);
  });
});

describe("chips", () => {
  it("reads the transcript through the chips the URL pressed, in the contract's own order", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "transcript", kinds: "errors,tools" },
    );
    // The first read is the whole run the page's figures count from; the
    // second is the filtered one the tab draws.
    expect(calls.transcript[0]?.[3]).toEqual({ kinds: [] });
    expect(calls.transcript[1]).toEqual([
      ctx,
      "tse_7k2m9q",
      "everything",
      { kinds: ["tools", "errors"] },
    ]);
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("chip-prompt")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("drops a word the contract does not publish rather than refusing the page (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "transcript", kinds: "thinking,proof,tools" },
    );
    expect(calls.transcript[1]?.[3]).toEqual({ kinds: ["tools"] });
    expect(screen.queryByTestId("chip-thinking")).toBeNull();
    expect(screen.queryByTestId("chip-proof")).toBeNull();
  });

  it("carries the zoom and the chips on every chip's own link, so one filter has one URL", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ zoom: "turns" })),
      },
      { tab: "transcript", zoom: "turns", kinds: "tools" },
    );
    expect(screen.getByTestId("chip-errors")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&zoom=turns&kinds=tools%2Cerrors",
    );
    // Pressing a chip that is on takes it off again.
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&zoom=turns",
    );
  });

  it("says no entry answers the filter rather than drawing an empty run (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ entries: [], kinds: ["policy"] })),
      },
      { tab: "transcript", kinds: "policy" },
    );
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Clear the filter",
    );
    expect(screen.queryByTestId("run-transport")).toBeNull();
  });
});

describe("chain and seal", () => {
  it("reads the chain only when its tab is open, and draws it", async () => {
    const { calls, container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        chain: ok(runChain()),
      },
      { tab: "chain" },
    );
    expect(calls.chain).toEqual([[ctx, "tse_7k2m9q"]]);
    expect(screen.getByTestId("chain-checkpoint")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Chain and seal/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The spec's four panels, in order.
    expect(
      within(screen.getByRole("tabpanel"))
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Hash chain",
      "Seal and attestation",
      "Replay grade",
      "Checkpoints",
    ]);
    const checkpoints = screen.getByRole("table", { name: "Checkpoints" });
    expect(
      within(checkpoints)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Frame", "Chain head", "Covers", "Signature"]);
    const grade = screen.getByRole("table", { name: "Replay grade" });
    expect(
      within(grade)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Grade", "What was recorded", "What it allows"]);
    await expectNoAxe(container);
  });

  it("names its own failure when the chain read is refused (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        chain: DENIED,
      },
      { tab: "chain" },
    );
    expect(screen.getByText(/run\.read/)).toBeTruthy();
    expect(screen.queryByTestId("chain-checkpoint")).toBeNull();
  });
});

describe("approvals on the run", () => {
  it("reads list_approvals narrowed to this run on every tab, and the resolved half only on Governed actions", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: ok([]),
      },
      // Transcript, not Governed actions: the parked dot reads on every tab.
      { tab: "transcript" },
    );
    expect(calls.approvals).toEqual([[ctx, { runId: "tse_7k2m9q" }]]);
    expect(calls.resolvedApprovals).toEqual([]);
    expect(screen.queryByTestId("run-tab-parked-actions")).toBeNull();
    cleanup();
    const opened = await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: ok([]),
      },
      { tab: "actions" },
    );
    expect(opened.calls.resolvedApprovals).toEqual([
      [ctx, { runId: "tse_7k2m9q" }],
    ]);
  });

  it("marks Governed actions and Policy with a dot while a call is parked on the run", async () => {
    await renderRun({
      detail: ok(runDetail()),
      approvals: ok({
        items: [
          {
            id: "apr_1",
            runId: "tse_7k2m9q",
            tool: "create_release",
            agentKey: "acme.core.release-bot",
            requester: "usr_marcusbell",
            mandateId: null,
            rule: null,
            autoEligibility: null,
            createdAt: new Date(NOW - 60_000).toISOString(),
            expiresAt: new Date(NOW + 3_600_000).toISOString(),
          },
        ],
        more: false,
      }),
      resolvedApprovals: ok([]),
    });
    expect(screen.getByTestId("run-tab-parked-actions")).toHaveTextContent(
      "a call is parked",
    );
    expect(screen.getByTestId("run-tab-parked-policy")).toBeTruthy();
  });

  it("says nothing is parked rather than drawing an empty strip (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: ok([]),
      },
      { tab: "approvals" },
    );
    expect(screen.queryByTestId("approval")).toBeNull();
    expect(screen.queryByTestId("resolved-approval")).toBeNull();
  });

  it("draws one card per approval recorded on the run", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({
          items: [
            {
              id: "apr_1",
              runId: "tse_7k2m9q",
              tool: "create_release",
              agentKey: "acme.core.release-bot",
              requester: "usr_marcusbell",
              mandateId: null,
              rule: null,
              autoEligibility: null,
              createdAt: new Date(NOW - 60_000).toISOString(),
              expiresAt: new Date(NOW + 3_600_000).toISOString(),
            },
          ],
          more: false,
        }),
        resolvedApprovals: ok([]),
      },
      { tab: "approvals" },
    );
    const card = screen.getAllByTestId("approval")[0];
    if (!card) throw new Error("Approval card missing");
    expect(card).toHaveTextContent("create_release");
  });

  // The Approvals tab is the second surface of `resolve_approval` and
  // `get_auto_eligibility` (capability-ui-map.json, binding.also). One
  // approval reads and decides the same on both pages, so the card here
  // carries the four-hop chain and the Decide control Fleet's panel carries.
  it("carries the chain and the decision on the run's own card, as Fleet does", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({
          items: [
            {
              id: "apr_1",
              runId: "tse_7k2m9q",
              tool: "create_release",
              agentKey: "acme.core.release-bot",
              requester: "usr_marcusbell",
              mandateId: null,
              rule: null,
              autoEligibility: {
                ruleRef: "small-vendor-payments",
                ok: false,
                reasons: ["measure_above_ceiling:amount"],
                floor: false,
              },
              createdAt: new Date(NOW - 60_000).toISOString(),
              expiresAt: new Date(NOW + 3_600_000).toISOString(),
            },
          ],
          more: false,
        }),
        resolvedApprovals: ok([]),
      },
      { tab: "approvals" },
    );
    const card = screen.getAllByTestId("approval")[0];
    if (!card) throw new Error("Approval card missing");
    const chain = within(card).getByTestId("chain");
    expect(chain).toHaveTextContent("usr_marcusbell");
    expect(chain).toHaveTextContent("acme.core.release-bot");
    expect(within(card).getByTestId("eligibility")).toHaveTextContent(
      "small-vendor-payments",
    );
    expect(within(card).getByTestId("decide")).toHaveTextContent("Decide");
  });

  // The Run page used to hand the panel an empty map, so every card here said
  // the mandate could not be read on the one page the call's run is in front
  // of you. It reads `list_mandates` under Fleet's rule now.
  it("reads the mandate ledger only when a parked call names a mandate, and draws its bar", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({
          items: [
            {
              id: "apr_1",
              runId: "tse_7k2m9q",
              tool: "create_release",
              agentKey: "acme.core.release-bot",
              requester: "usr_marcusbell",
              mandateId: "mnd_4f2a9c",
              rule: "mandate:mnd_4f2a9c:human_above:amount",
              autoEligibility: null,
              createdAt: new Date(NOW - 60_000).toISOString(),
              expiresAt: new Date(NOW + 3_600_000).toISOString(),
            },
          ],
          more: false,
        }),
        resolvedApprovals: ok([]),
        mandates: mandateList([mandateRow()]),
      },
      { tab: "approvals" },
    );
    expect(calls.mandates).toEqual([[ctx, { agentId: null }]]);
    const card = screen.getAllByTestId("approval")[0];
    if (!card) throw new Error("Approval card missing");
    expect(within(card).getByTestId("mandate-bar")).toHaveAttribute(
      "data-measure",
      "amount",
    );
  });

  it("makes no mandate read for a run whose parked calls name none (negative)", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({
          items: [
            {
              id: "apr_1",
              runId: "tse_7k2m9q",
              tool: "create_release",
              agentKey: null,
              requester: "usr_marcusbell",
              mandateId: null,
              rule: null,
              autoEligibility: null,
              createdAt: new Date(NOW - 60_000).toISOString(),
              expiresAt: new Date(NOW + 3_600_000).toISOString(),
            },
          ],
          more: false,
        }),
        resolvedApprovals: ok([]),
      },
      { tab: "approvals" },
    );
    expect(calls.mandates).toEqual([]);
  });

  // #3153: the receipt a decision rule leaves when it releases a call with
  // no person, read back for the first time.
  it("draws the resolved section, naming the rule that released a call with no person", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: ok([
          {
            id: "apr_2",
            runId: "tse_7k2m9q",
            tool: "stripe__create_payment",
            requester: null,
            createdAt: new Date(NOW - 60_000).toISOString(),
            expiresAt: new Date(NOW + 3_600_000).toISOString(),
            resolvedAt: new Date(NOW - 30_000).toISOString(),
            resolution: "approved",
            execution: {
              status: "succeeded",
              runId: "arun_resumed",
              reason: null,
            },
            resolvedBy: "policy:small-vendor-payments",
            autoRuleRef: "small-vendor-payments",
          },
        ]),
      },
      { tab: "approvals" },
    );
    expect(screen.getByTestId("approval-execution")).toHaveTextContent(
      "succeeded",
    );
    expect(screen.getByText("arun_resumed")).toBeInTheDocument();
    const [card] = screen.getAllByTestId("resolved-approval");
    expect(card).toHaveTextContent("stripe__create_payment");
    expect(screen.getByTestId("resolved-approver")).toHaveTextContent(
      "small-vendor-payments",
    );
  });

  it("labels an expired approval without guessing its cause", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: ok([
          {
            id: "apr_expired",
            runId: "tse_7k2m9q",
            tool: "delete_workspace",
            requester: null,
            createdAt: new Date(NOW - 600_000).toISOString(),
            expiresAt: new Date(NOW - 300_000).toISOString(),
            resolvedAt: new Date(NOW - 300_000).toISOString(),
            resolution: "expired",
            resolvedBy: null,
            autoRuleRef: null,
          },
        ]),
      },
      { tab: "approvals" },
    );
    expect(screen.getByTestId("resolved-approver")).toHaveTextContent(
      /^system$/,
    );
    expect(screen.getByTestId("resolved-approver")).not.toHaveTextContent(
      "unknown",
    );
  });

  it("names its own failure when the resolved read is refused (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: DOWN,
      },
      { tab: "approvals" },
    );
    expect(screen.getByText(/frame_store_unreachable/)).toBeTruthy();
  });
});

describe("cost", () => {
  it("reads the rollup and the run's own per-turn ledger, and lays the turns out as bars", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        cost: ok(runCost()),
        transcript: (zoom) =>
          ok(
            runTranscript({
              zoom,
              entries:
                zoom === "turns"
                  ? [
                      transcriptEntry({
                        seq: "1",
                        endSeq: "20",
                        kind: "turn",
                        label: "turn 1",
                      }),
                    ]
                  : [transcriptEntry({ seq: "11", endSeq: "14" })],
            }),
          ),
      },
      { tab: "cost" },
    );
    expect(calls.cost).toHaveLength(1);
    expect(calls.transcript.map((call) => call[2])).toEqual([
      "everything",
      "turns",
      "steps",
    ]);
    expect(screen.getAllByTestId("waterfall-bar")).toHaveLength(1);
  });
});

describe("figures", () => {
  it("draws the six figures from the rollup, with the cost's basis beside it", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(
        runTranscript({
          entries: [
            transcriptEntry({ seq: "1", endSeq: "1", kinds: ["prompt"] }),
            transcriptEntry(),
          ],
        }),
      ),
    });
    const stats = within(screen.getByTestId("run-stats"));
    // Tokens reconcile to the classes: input is uncached, cache reads and
    // writes; output is output and reasoning.
    expect(stats.getByText("128,343")).toBeTruthy();
    expect(stats.getByText("113,328 in, 15,015 out")).toBeTruthy();
    expect(stats.getByText("1")).toBeTruthy();
    expect(stats.getByText("one-shot session")).toBeTruthy();
    expect(stats.getByText("$4.13")).toBeTruthy();
    // The cost's caption is its basis and nothing stronger.
    expect(stats.getByText("gateway_observed")).toBeTruthy();
    // 29% of $4.131265 that the rollup did not count as productive.
    expect(stats.getByText("$1.20")).toBeTruthy();
    expect(stats.getByText("unproductive steps")).toBeTruthy();
    expect(stats.getByText("83%")).toBeTruthy();
    expect(stats.getByText("saving not recorded")).toBeTruthy();
    expect(stats.getByText("split not recorded")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("counts every prompt after the first as corrective, in Prompts and in Wasted", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(
        runTranscript({
          entries: [
            transcriptEntry({ seq: "1", endSeq: "1", kinds: ["prompt"] }),
            transcriptEntry({ seq: "5", endSeq: "5", kinds: ["prompt"] }),
            transcriptEntry({ seq: "9", endSeq: "9", kinds: ["prompt"] }),
          ],
        }),
      ),
    });
    const stats = within(screen.getByTestId("run-stats"));
    expect(stats.getByText("3")).toHaveClass("text-info");
    expect(stats.getByText("2 corrective")).toBeTruthy();
    expect(stats.getByText("2 corrective prompts")).toBeTruthy();
  });

  it("marks a prompt count from a transcript that stopped short as a floor (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(
        runTranscript({
          complete: false,
          entries: [transcriptEntry({ kinds: ["prompt"] })],
        }),
      ),
    });
    const stats = within(screen.getByTestId("run-stats"));
    expect(stats.getByText("1+")).toBeTruthy();
    expect(stats.getByText("at least this many")).toBeTruthy();
  });
});

describe("the work", () => {
  it("counts the pull requests, commits and changed lines the outputs recorded", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      outputs: ok(
        runOutputs([
          runOutputNode({ seq: "90", kind: "pr", name: "#4121", stat: null }),
          runOutputNode({
            seq: "91",
            kind: "commit",
            name: "a1b2c3d",
            stat: null,
          }),
          runOutputNode(),
        ]),
      ),
    });
    const work = within(
      screen.getByRole("complementary", { name: "The work" }),
    );
    const changes = within(work.getByRole("region", { name: "Changes" }));
    expect(changes.getByText("#4121")).toBeTruthy();
    // The spec's rows, in order.
    expect(
      changes.getAllByRole("term").map((term) => term.textContent),
    ).toEqual(["Pull request", "Base", "Checks", "Diff"]);
    expect(changes.getByText("not captured on this run")).toBeTruthy();
    expect(changes.getByText("none reported")).toBeTruthy();
    expect(changes.getByText("in 1 file")).toBeTruthy();
    // The header's checkout strip names the same pull request.
    expect(screen.getByTestId("run-checkout-pr")).toHaveTextContent("#4121");
    expect(
      within(changes.getByTestId("run-changed-files")).getByText(
        "src/release/cut.ts",
      ),
    ).toBeTruthy();
    await expectNoAxe(container);
  });

  it("says no file change was recorded rather than printing a zero diff (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      outputs: ok(runOutputs([])),
    });
    const changes = within(screen.getByRole("region", { name: "Changes" }));
    expect(changes.getByText("no file change recorded")).toBeTruthy();
    expect(changes.getByText("none yet")).toBeTruthy();
  });

  it("prints Spend by area's total with its basis, names the split's gap, and lists the dearest tools", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const spend = within(screen.getByRole("region", { name: "Spend by area" }));
    expect(spend.getByText(/gateway_observed/)).toBeTruthy();
    expect(spend.getByTestId("run-spend-unsplit")).toHaveAttribute(
      "data-gap",
      "G3",
    );
    expect(spend.getByTestId("run-dearest-tools")).toHaveTextContent(
      "create_release3 calls",
    );
    expect(
      spend.getByRole("link", { name: "All 1 tools on Cost" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/tse_7k2m9q?tab=cost");
  });

  it("says the rollup is not built yet rather than drawing an empty split (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: null })),
    });
    expect(screen.queryByTestId("run-spend-unsplit")).toBeNull();
    expect(
      screen.getByText("No cost rollup yet. It is built after the run seals."),
    ).toBeTruthy();
  });
});

describe("issues", () => {
  it("lists the task the run was started on", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "issues" },
    );
    const issues = within(screen.getByRole("region", { name: "Issues" }));
    expect(
      within(issues.getByRole("table"))
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Issue", "Status", "Relation", "Edge", "Tracker"]);
    const row = within(issues.getByTestId("run-issue-row"));
    expect(row.getByText(/ENG-4121/)).toBeTruthy();
    expect(row.getByText("not read")).toBeTruthy();
    expect(row.getByText("task")).toBeTruthy();
    expect(row.getByText("stated")).toBeTruthy();
    // A reference that names no tracker page says so.
    expect(row.getByText("no link")).toBeTruthy();
    expect(issues.getByText("1 in this session")).toBeTruthy();
    // Linked work follows the table, once.
    expect(screen.getByTestId("run-linked-work")).toBeTruthy();
    expect(screen.getAllByRole("table", { name: "Issues" })).toHaveLength(1);
    await expectNoAxe(container);
  });

  it("links a GitHub issue reference to its tracker page, and lists linked work with its frame", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({ run: runRow({ taskRef: "acme/platform#482" }) }),
        ),
        transcript: ok(runTranscript()),
        outputs: ok(
          runOutputs([
            runOutputNode({ seq: "90", kind: "pr", name: "#4121", stat: null }),
            runOutputNode(),
          ]),
        ),
      },
      { tab: "issues" },
    );
    expect(screen.getByRole("link", { name: "View ↗" })).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/issues/482",
    );
    const linked = within(screen.getByTestId("run-linked-work"));
    expect(
      within(
        linked.getByRole("region", { name: "Pull requests and artifacts" }),
      ).getByText("#4121"),
    ).toBeTruthy();
    expect(linked.getByRole("link", { name: "fr 90" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=90",
    );
    expect(
      within(linked.getByRole("region", { name: "Files changed" })).getByText(
        "src/release/cut.ts",
      ),
    ).toBeTruthy();
    expect(
      within(linked.getByRole("region", { name: "Repositories" })).getByText(
        "The run record does not name the repository it worked in.",
      ),
    ).toBeTruthy();
  });

  it("says a run with no task reference names no issue (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail({ run: runRow({ taskRef: null }) })),
        transcript: ok(runTranscript()),
      },
      { tab: "issues" },
    );
    expect(
      screen.getByText("No issue is linked to this session."),
    ).toBeTruthy();
    expect(screen.getByTestId("run-tab-count-issues")).toHaveTextContent("0");
  });
});

describe("policy and context", () => {
  const decided = transcriptEntry({
    seq: "40",
    endSeq: "41",
    kind: "tool_call",
    label: "Bash",
    kinds: ["tools", "policy"],
    decision: {
      seq: "41",
      decision: "deny",
      type: "policy.denied",
      at: "2026-09-20T00:00:00Z",
    },
  });
  const recalled = transcriptEntry({
    seq: "30",
    endSeq: "30",
    label: "engram recall",
    kinds: ["recall"],
  });

  it("lists each policy decision from the whole-run read, linked to its frame", async () => {
    const { calls, container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ entries: [recalled, decided] })),
      },
      { tab: "policy" },
    );
    expect(calls.transcript).toHaveLength(1);
    const policy = within(
      screen.getByRole("region", { name: "Policy decisions" }),
    );
    expect(policy.getByText("Bash")).toBeTruthy();
    expect(policy.getByText("deny")).toBeTruthy();
    expect(
      within(policy.getByRole("table"))
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Frame",
      "Call",
      "Outcome",
      "Rules that fired",
      "Taint",
      "Latency",
    ]);
    expect(policy.getByRole("link", { name: "41" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=41",
    );
    expect(policy.queryByText("engram recall")).toBeNull();
    expect(screen.getByTestId("run-tab-count-policy")).toHaveTextContent("1");
    await expectNoAxe(container);
  });

  it("lists each recall, and says when there is none (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ entries: [recalled, decided] })),
      },
      { tab: "context" },
    );
    const context = within(
      screen.getByRole("region", { name: "context.frames" }),
    );
    expect(context.getByText("engram recall")).toBeTruthy();
    expect(context.queryByText("Bash")).toBeNull();
    // The window itself needs USED_CONTEXT edges (G10), and says so.
    expect(screen.getByText("No window on record")).toBeTruthy();
    expect(
      within(
        screen.getByRole("region", { name: "Steering manifest" }),
      ).getByText(/This run sealed no steering.manifest frame/),
    ).toBeTruthy();
    cleanup();
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "context" },
    );
    expect(screen.getByText("This run recorded no recall.")).toBeTruthy();
  });

  it("draws the steering manifest the session sealed, rendered and cut, from that frame's body", async () => {
    const manifest = transcriptEntry({
      seq: "2",
      endSeq: "2",
      kind: "frame",
      type: "steering.manifest",
      label: "steering.manifest",
      kinds: [],
    });
    const body = JSON.stringify({
      schema: "oxagen.steering.manifest/1",
      delivers: ["must"],
      budget_tokens: 4000,
      spent_tokens: 1340,
      included: 1,
      cut: 1,
      text_digest: null,
      items: [
        {
          id: "ctx.release.notes-format",
          kind: "instruction",
          force: "must",
          recorded_at: "2026-09-20T00:00:00Z",
          tokens: 1340,
          outcome: "included",
        },
        {
          id: "ctx.release.old-format",
          kind: "instruction",
          force: "should",
          recorded_at: "2026-09-19T00:00:00Z",
          tokens: 900,
          outcome: "cut",
          reason: "budget",
        },
      ],
      bundle_version: 7,
      bundle_etag: "etag-7",
    });
    const { calls, container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ entries: [manifest, recalled] })),
        frameBody: ok(runFrameBody({ seq: "2", text: body })),
      },
      { tab: "context" },
    );
    expect(calls.frameBody).toEqual([[ctx, "tse_7k2m9q", "2"]]);
    const panel = within(
      screen.getByRole("region", { name: "Steering manifest" }),
    );
    expect(panel.getByTestId("run-manifest-tally")).toHaveTextContent(
      "1 rendered · 1 cut · 1,340 tok",
    );
    expect(panel.getByText("ctx.release.notes-format")).toBeTruthy();
    const cut = panel.getByTestId("run-manifest-cut");
    expect(cut).toHaveTextContent("ctx.release.old-format");
    expect(cut).toHaveTextContent("it did not fit the token budget");
    expect(panel.getByText(/bundle v7 · frame 2/)).toBeTruthy();
    await expectNoAxe(container);
  });

  it("reads no frame body on Context when the run sealed no manifest (negative)", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ entries: [recalled] })),
      },
      { tab: "context" },
    );
    expect(calls.frameBody).toEqual([]);
  });

  it("says a list from a transcript that stopped short is missing later decisions (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ complete: false, entries: [decided] })),
      },
      { tab: "policy" },
    );
    expect(
      screen.getByText(
        "The transcript read stopped short, so later decisions are missing here.",
      ),
    ).toBeTruthy();
  });

  it("names the transcript read's failure instead of an empty list (negative)", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: DOWN },
      { tab: "policy" },
    );
    expect(
      screen.queryByText("No policy decision was recorded on this run."),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("region", { name: "Policy decisions" }),
      ).getByText(/frame_store_unreachable|could not|failed/i),
    ).toBeTruthy();
    // A count from a failed read is left off, never drawn as a zero.
    expect(screen.queryByTestId("run-tab-count-policy")).toBeNull();
  });
});

describe("loading", () => {
  it("replaces the page body with a skeleton shaped like the answer, and never the shell", async () => {
    const { container } = render(
      <IntlProvider>
        <RunLoading />
      </IntlProvider>,
    );
    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Loading this run");
    // The spec's skeleton: four tile blocks and a panel of seven rows, and no
    // figure, heading or run id before the read lands.
    expect(screen.getAllByTestId("run-loading-tile")).toHaveLength(4);
    expect(screen.getAllByTestId("run-loading-row")).toHaveLength(7);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(loading.textContent).not.toMatch(/\d/);
    await expectNoAxe(container);
  });

  it("keeps the page's own main container, rather than exporting the skeleton alone", () => {
    render(
      <IntlProvider>
        <RunLoading />
      </IntlProvider>,
    );
    // Next swaps page.tsx's whole return value for this default export while
    // the route suspends, so the skip-to-content target and the page frame
    // have to come from here too, or a stranger's tab-order loses its anchor
    // and the layout jumps once the real page takes the same container.
    const main = document.getElementById("main");
    expect(main).not.toBeNull();
    expect(main?.tagName).toBe("MAIN");
    expect(main).toContainElement(screen.getByRole("status"));
  });
});
