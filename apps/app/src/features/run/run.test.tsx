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
  runRoster,
  runTranscript,
  runWork,
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
vi.mock("../run-outcomes/actions", () => ({
  setRunOutcomesConsentAction: vi.fn(),
}));
vi.mock("../run-outcomes/provider-actions", () => ({
  loadRunIssueProviders: vi.fn(),
  authorizeRunIssues: vi.fn(),
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
  // Inside an async act, so the work read the header and the Changes panel
  // suspend on has settled before the test reads the page.
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<IntlProvider>{element}</IntlProvider>));
  });
  return { container, calls };
}

const ok = readOk;

/** One call parked on this run, as `list_approvals` answers it. */
const approval = () => ({
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
});

afterEach(() => {
  cleanup();
  notFound.mockClear();
});

describe("header", () => {
  it("heads the page with the eyebrow and the run id as a mono h1", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(/^tse_7k2m9q$/);
    expect(h1.className).toContain("font-mono");
    expect(
      within(screen.getByTestId("run-header")).getByText("Run"),
    ).toBeTruthy();
    await expectNoAxe(container);
  });

  it("titles the when line with the generated name and draws the model's summary as generated", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-when")).toHaveTextContent(
      "Cut the 3.2 release branch",
    );
    const summary = within(screen.getByTestId("run-summary"));
    expect(summary.getByTestId("generated-summary")).toHaveTextContent(
      "Cut release/3.2 from main",
    );
    expect(summary.getByText("generated · not the record")).toBeTruthy();
    expect(summary.getByText("z-ai/glm-flash-latest")).toBeTruthy();
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
            status: "live",
            sealedAt: null,
            replayGrade: null,
          }),
        }),
      ),
      transcript: readError("frame_store_unreachable", 502),
      cost: ok(runCost({ rollup: null })),
    });
    const stats = within(screen.getByTestId("run-stats"));
    // Tokens, prompts, cost, wasted, wall clock and cache hit: nothing backs any.
    expect(stats.getAllByText("not recorded")).toHaveLength(6);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("leaves out the generated name when automatic names are disabled", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            enrichmentEnabled: false,
            name: "Old generated name",
            taskRef: "A derived project label",
            summary: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByText("Old generated name")).toBeNull();
    expect(screen.getByTestId("run-when")).toHaveTextContent(
      "A derived project label",
    );
    expect(
      within(screen.getByTestId("run-summary")).getByRole("checkbox", {
        name: "Automatic run names and summaries",
      }),
    ).not.toBeChecked();
  });

  it("draws the agent, status, tier and task chips, and the rig the run ran on", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const chips = within(screen.getByTestId("run-chips"));
    // The tier is its own recorded word, with the longer reading on hover.
    expect(chips.getByTestId("run-tier")).toHaveTextContent(/^harness$/);
    expect(chips.getByTestId("run-tier")).toHaveAttribute(
      "title",
      "observed at the harness",
    );
    expect(chips.getByTestId("run-task")).toHaveTextContent(
      "task ENG-4121 cut the 3.2 release",
    );
    expect(chips.getByText("fork replay")).toBeTruthy();
    const rig = within(screen.getByTestId("run-rig"));
    expect(rig.getByText("claude-sonnet-5")).toHaveAttribute(
      "title",
      "anthropic sonnet",
    );
    // The session recorded its harness, so the rig names it and its version.
    expect(rig.getByText("Claude Code")).toBeTruthy();
    expect(rig.getByText("2.1.0")).toBeTruthy();
    // Oxagen never guesses an effort value.
    expect(screen.getByTestId("run-effort")).toHaveTextContent(
      "effort not captured",
    );
    await expectNoAxe(container);
  });

  it("reads the agent's 30-day runs and spend onto its card, and leaves them off when the roster does not hold it", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      roster: ok(runRoster()),
    });
    expect(
      within(screen.getByTestId("run-chips")).getByText(/212 runs 30d/),
    ).toBeTruthy();
    expect(screen.getByTestId("run-chips")).toHaveTextContent(
      "Claude Code · 212 runs 30d · $612.48",
    );
    cleanup();
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      roster: ok(runRoster({ agentKey: "acme.core.someone-else" })),
    });
    expect(screen.getByTestId("run-chips")).not.toHaveTextContent("runs 30d");
  });

  it("prints the checkout the host enrolled: the repository, the branch, the pull request and a copyable path", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(runWork()),
    });
    const checkout = within(await screen.findByTestId("run-checkout"));
    expect(
      (
        await checkout.findByRole("link", { name: "acme/platform" })
      ).getAttribute("href"),
    ).toBe("https://github.com/acme/platform");
    // A branch that is a pull request's head links to the pull request.
    expect(
      checkout.getByRole("link", { name: "release/3.2" }).getAttribute("href"),
    ).toBe("https://github.com/acme/platform/pull/482");
    expect(
      checkout
        .getByRole("link", { name: "acme/platform#482" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/platform/pull/482");
    const path = checkout.getByTestId("run-checkout-path");
    expect(path).toHaveTextContent(
      "mac-studio.local:~/src/platform/.worktrees/release-3.2",
    );
    expect(path.getAttribute("title")).toContain(
      "Oxagen recorded this checkout on mac-studio.local.",
    );
    await expectNoAxe(container);
  });

  it("names the host with no enrolled checkout and says no path is held, with the host's facts on hover", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const machine = await screen.findByTestId("run-machine");
    expect(machine).toHaveTextContent("mac-studio.local");
    expect(machine).toHaveTextContent("path not captured");
    const title = machine.getAttribute("title") ?? "";
    expect(title).toContain("Session machine facts not recorded.");
    expect(title).toContain(
      "Enrollment hostname and facts: darwin · 15.6 · arm64 · v24.4.0",
    );
    expect(
      within(screen.getByTestId("run-checkout")).getByText("no pull request"),
    ).toBeTruthy();
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
    const title =
      (await screen.findByTestId("run-machine")).getAttribute("title") ?? "";
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
    const machine = await screen.findByTestId("run-machine");
    expect(machine).toHaveTextContent("machine not recorded");
    expect(machine).toHaveAttribute(
      "title",
      "The evidence ledger records no host for a run.",
    );
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
    expect(operator).toHaveTextContent(/^not recorded$/);
  });

  it("draws the pause banner only while ingress is paused", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", ingressPaused: true }) }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-paused")).toHaveTextContent("Paused.");
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
      /^prn_unknown_kindoperator$/,
    );
    expect(screen.getByTestId("run-operator")).not.toHaveTextContent(
      "not recorded",
    );
  });

  it("names the operator the agent acted for, with its hover card", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const operator = screen.getByTestId("run-operator-name");
    expect(operator).toHaveTextContent(/^Marcus Belloperator$/);
    expect(operator.getAttribute("data-operator-id")).toBe("prn_marcusbell");
    // The id is a key, not a label: it is in the hover card, never in the line.
    expect(
      within(screen.getByTestId("run-involved")).queryByText("prn_marcusbell"),
    ).toBeNull();
    await userEvent.hover(operator);
    expect(screen.getByTestId("operator-card")).toHaveTextContent(
      "prn_marcusbell",
    );
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

  it("names the controls as the design does, with Cancel as the one danger action", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ status: "live" }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-pause")).toHaveTextContent("❙❙ Pause run");
    expect(screen.getByTestId("run-resume")).toHaveTextContent("▶ Resume run");
    expect(screen.getByTestId("run-cancel").className).toContain(
      "text-error-ink",
    );
    expect(screen.getByTestId("run-steer").className).not.toContain(
      "text-error-ink",
    );
  });

  it("ends a live run's actions on Export, drawn disabled until the run seals", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ status: "live" }) })),
      transcript: ok(runTranscript()),
    });
    const actions = within(screen.getByTestId("run-actions"));
    const buttons = actions.getAllByRole("button");
    expect(buttons.at(-1)).toBe(actions.getByTestId("run-export"));
    expect(actions.getByTestId("run-export")).toBeDisabled();
    expect(actions.getByTestId("run-export")).toHaveAttribute(
      "data-reason",
      "export-live",
    );
  });

  it("offers Fork replay, Bisect and Export on a sealed run, and no command", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const actions = within(screen.getByTestId("run-actions"));
    expect(actions.queryByTestId("run-pause")).toBeNull();
    // A wrapped session has no ledger attempt to branch from, and says so.
    expect(actions.getByTestId("run-fork")).toBeDisabled();
    expect(actions.getByTestId("run-fork").getAttribute("title")).toContain(
      "Forking replays an attempt from the evidence ledger",
    );
    expect(actions.getByRole("button", { name: "Bisect" })).toBeEnabled();
    expect(actions.getByTestId("run-export")).toBeEnabled();
    // Summarize is the Summary panel's, beside what it writes.
    expect(
      within(screen.getByTestId("run-summary")).getByTestId("run-resummarize"),
    ).toBeTruthy();
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
    const exportButton = screen.getByTestId("run-export");
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAttribute("data-reason", "export-no-role");
    expect(exportButton.getAttribute("title")).toContain("Owner or Admin role");
    expect(screen.getByTestId("run-resummarize")).not.toBeDisabled();
    await expectNoAxe(container);
  });

  it("draws both record writes disabled for an organization Viewer (negative)", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { viewer: viewerCtx },
    );
    expect(screen.getByTestId("run-resummarize")).toBeDisabled();
    expect(screen.getByTestId("run-resummarize")).toHaveAttribute(
      "data-reason",
      "summarize-no-role",
    );
    expect(screen.getByTestId("run-export")).toBeDisabled();
  });

  it("offers Export to an Owner with no reason attached", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-export")).not.toBeDisabled();
    expect(screen.getByTestId("run-export")).not.toHaveAttribute("data-reason");
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
    expect(screen.getByTestId("run-tab-transcript")).toBeTruthy();
    expect(
      screen.getByText(
        /What this run produced could not be loaded.*frame_store_unreachable/,
      ),
    ).toBeTruthy();
  });
});

describe("tabs", () => {
  it("opens Transcript by default and reads the whole-run transcript once", async () => {
    const { calls } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-tab-transcript")).toBeTruthy();
    // The stat row, the tab counts, Policy, Context and the Transcript tab
    // share one read.
    expect(calls.transcript).toEqual([
      [ctx, "tse_7k2m9q", "everything", { kinds: [] }],
    ]);
    expect(calls.cost).toHaveLength(1);
    expect(calls.chain).toHaveLength(0);
  });

  it("reads every frame once whatever zoom the URL names (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { zoom: "everything-else" },
    );
    expect(calls.transcript).toEqual([
      [ctx, "tse_7k2m9q", "everything", { kinds: [] }],
    ]);
  });

  it("opens Transcript for a tab that is not a section, and Cost for the retired proof tab (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "no-such-tab" },
    );
    expect(screen.getByTestId("run-tab-transcript")).toBeTruthy();
    expect(calls.chain).toHaveLength(0);
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
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const tabs = within(screen.getByRole("tablist", { name: "Run sections" }));
    expect(
      tabs.getAllByRole("tab").map((tab) => tab.getAttribute("href")),
    ).toEqual(
      [
        "transcript",
        "issues",
        "actions",
        "cost",
        "policy",
        "context",
        "chain",
      ].map((tab) => `/acme/core-platform/runs/tse_7k2m9q?tab=${tab}`),
    );
    expect(tabs.getByRole("tab", { name: /Transcript/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("run-tab-count-issues")).toHaveTextContent("1");
    // A run with no policy decision has nothing governed to list: the tab is
    // the frame player, and it counts the frames.
    expect(tabs.getByRole("tab", { name: /Player/ })).toBeTruthy();
    expect(screen.getByTestId("run-tab-count-actions")).toHaveTextContent(
      "431",
    );
    expect(screen.getByTestId("run-tab-count-cost")).toHaveTextContent("$4.13");
    expect(screen.getByTestId("run-tab-count-chain")).toHaveTextContent(
      "sealed",
    );
    await expectNoAxe(container);
  });

  it("names the tab Governed actions and marks it when a call is parked on the run", async () => {
    const entries = mockupTranscript().entries.map((entry) =>
      entry.type === "policy_decision"
        ? { ...entry, kinds: [...entry.kinds, "policy" as const] }
        : entry,
    );
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(mockupTranscript({ entries })),
      approvals: ok({ items: [approval()], more: false }),
    });
    expect(screen.getByRole("tab", { name: /Governed actions/ })).toBeTruthy();
    expect(screen.getByTestId("run-tab-count-actions")).toHaveTextContent("2");
    expect(screen.getByTestId("run-tab-parked-actions")).toBeTruthy();
    expect(screen.getByTestId("run-tab-parked-policy")).toBeTruthy();
  });

  it("marks a count read from a transcript that stopped short as a floor", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript({ complete: false })),
    });
    expect(screen.getByTestId("run-tab-count-policy")).toHaveTextContent(/\+$/);
  });

  it("opens Governed actions for the retired frames, approvals and player tab names", async () => {
    for (const tab of ["frames", "approvals", "player"]) {
      cleanup();
      await renderRun(
        { detail: ok(runDetail()), transcript: ok(runTranscript()) },
        { tab },
      );
      expect(screen.getByRole("tab", { name: /Player/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
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
      fireEvent.click(screen.getByRole("button", { name: "×2" }));
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
    const section = screen.getByRole("region", { name: "Cost" });
    expect(section).toHaveTextContent("gateway_observed");
    expect(section).toHaveTextContent("cache read");
    expect(section).toHaveTextContent("prc_01k4qj9e");
    expect(screen.getByTestId("cost-model-row")).toHaveTextContent(
      "claude-opus-5",
    );
    expect(screen.getByTestId("cost-tool-row")).toHaveTextContent(
      "create_release",
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
    expect(screen.queryByTestId("cost-model-row")).toBeNull();
  });
});

describe("failures", () => {
  it("is not found when the run is not in this workspace (negative)", async () => {
    await expect(
      renderRun({ detail: readError("run_not_found", 404) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("replaces the body with the error state: the code, Try again, Open an incident and the trace line (negative)", async () => {
    const { container } = await renderRun({ detail: DOWN });
    const state = within(screen.getByTestId("run-error"));
    expect(
      state.getByRole("heading", { name: "This run could not be loaded" }),
    ).toBeTruthy();
    expect(state.getByText("502 frame_store_unreachable")).toBeTruthy();
    expect(state.getByText(/Runs kept recording/)).toBeTruthy();
    expect(state.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(
      state.getByRole("button", { name: "Open an incident" }),
    ).toBeTruthy();
    // A failed read carries no trace id or region: the line says so and
    // prints the instant the read failed.
    expect(state.getByTestId("run-error-trace")).toHaveTextContent(
      "trace and region not recorded · 2026-09-15 09:00:00Z",
    );
    expect(screen.queryByTestId("run-header")).toBeNull();
    await expectNoAxe(container);
  });

  it("names the permission a denied viewer lacks and offers Request access (negative)", async () => {
    const { container } = await renderRun({ detail: DENIED });
    const state = within(screen.getByTestId("run-denied"));
    expect(
      state.getByRole("heading", { name: "You cannot see this run" }),
    ).toBeTruthy();
    expect(state.getAllByText("run.read on core-platform")).toHaveLength(2);
    expect(state.getByRole("button", { name: "Request access" })).toBeTruthy();
    expect(
      state.getByRole("link", { name: "Back to Fleet" }).getAttribute("href"),
    ).toBe("/acme/core-platform");
    await expectNoAxe(container);
  });

  it("says a run with no frames yet has cost nothing, and offers the way back (negative)", async () => {
    const { container, calls } = await renderRun({
      detail: ok(runDetail({ run: runRow({ frames: 0 }) })),
    });
    const state = within(screen.getByTestId("run-empty"));
    expect(
      state.getByRole("heading", { name: "This run has no frames yet" }),
    ).toBeTruthy();
    expect(
      state.getByText(/has cost nothing and is not billable/),
    ).toBeTruthy();
    expect(state.getByRole("link", { name: "Back to Fleet" })).toBeTruthy();
    // Nothing else is read for a run with nothing to read.
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
    expect(
      screen.getByRole("link", { name: /Chain and seal/ }),
    ).toHaveAttribute("aria-current", "page");
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
  it("reads list_approvals and list_resolved_approvals narrowed to this run, for the tab's count", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: ok([]),
      },
      // Transcript, not Governed actions: the count reads on every tab.
      { tab: "transcript" },
    );
    expect(calls.approvals).toEqual([[ctx, { runId: "tse_7k2m9q" }]]);
    expect(calls.resolvedApprovals).toEqual([[ctx, { runId: "tse_7k2m9q" }]]);
    expect(screen.getByTestId("run-tab-count-actions")).toHaveTextContent("0");
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
  it("draws the six figures from the one derivation, each with its line", async () => {
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
    const stat = (id: string) => within(screen.getByTestId(`run-stat-${id}`));
    // 18,204 + 91,022 + 4,102 in, 12,004 + 3,011 out.
    expect(stat("tokens").getByText("128,343")).toBeTruthy();
    expect(stat("tokens").getByText("113,328 in, 15,015 out")).toBeTruthy();
    expect(stat("prompts").getByText("1")).toBeTruthy();
    expect(stat("prompts").getByText("one-shot session")).toBeTruthy();
    expect(stat("cost").getByText("$4.13")).toBeTruthy();
    expect(stat("cost").getByText("gateway_observed")).toBeTruthy();
    // 29% of $4.131265 that the rollup did not count as productive.
    expect(stat("wasted").getByText("$1.20")).toBeTruthy();
    expect(
      stat("wasted").getByText("steps that did not advance the task"),
    ).toBeTruthy();
    expect(stat("cache").getByText("83%")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("counts every prompt after the first as corrective, in the approval hue above two", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(
        runTranscript({
          entries: ["1", "2", "3"].map((seq) =>
            transcriptEntry({ seq, endSeq: seq, kinds: ["prompt"] }),
          ),
        }),
      ),
    });
    const prompts = screen.getByTestId("run-stat-prompts");
    expect(within(prompts).getByText("3")).toBeTruthy();
    expect(within(prompts).getByText("2 corrective")).toBeTruthy();
    expect(within(prompts).getByText("3").className).toContain("text-info");
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
    expect(
      within(screen.getByTestId("run-stat-prompts")).getByText("1+"),
    ).toBeTruthy();
  });
});

describe("the work", () => {
  it("lists the pull request with its state, the checks, the diff and each changed file", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(runWork()),
      outputs: ok(runOutputs([runOutputNode()])),
    });
    const work = within(
      screen.getByRole("complementary", { name: "The work" }),
    );
    const changes = within(await work.findByTestId("run-changes"));
    expect(
      changes
        .getByRole("link", { name: "acme/platform#482" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/platform/pull/482");
    expect(changes.getAllByText("passed").length).toBeGreaterThan(0);
    expect(changes.getByText("test success")).toBeTruthy();
    expect(changes.getByText("in 1 file")).toBeTruthy();
    expect(
      within(changes.getByTestId("run-changed-files")).getByText(
        "src/release/cut.ts",
      ),
    ).toBeTruthy();
    // No read carries the base branch, so it is not named.
    expect(changes.getByText("not recorded")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("names the same pull request as the checkout strip, from the one work read", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(runWork()),
    });
    const strip = within(await screen.findByTestId("run-checkout"));
    const changes = within(screen.getByTestId("run-changes"));
    expect(strip.getByRole("link", { name: "acme/platform#482" })).toBeTruthy();
    expect(
      changes.getByRole("link", { name: "acme/platform#482" }),
    ).toBeTruthy();
  });

  it("says no file change was recorded and no pull request exists rather than printing zeros (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", sealedAt: null }) }),
      ),
      transcript: ok(runTranscript()),
      outputs: ok(runOutputs([])),
    });
    const changes = within(await screen.findByTestId("run-changes"));
    expect(changes.getByText("no file change recorded")).toBeTruthy();
    expect(
      changes.getByText("none yet, the run is still working"),
    ).toBeTruthy();
    expect(changes.getByText("none reported")).toBeTruthy();
    expect(changes.queryByText("+0")).toBeNull();
  });
});

describe("issues", () => {
  it("lists the task the run was started on", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "issues" },
    );
    const issues = within(screen.getByRole("region", { name: "Issues" }));
    expect(issues.getByText(/ENG-4121/)).toBeTruthy();
    expect(issues.getByText("Task the run was started on")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("says a run with no task reference names no issue (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail({ run: runRow({ taskRef: null }) })),
        transcript: ok(runTranscript()),
      },
      { tab: "issues" },
    );
    expect(screen.getByText("This run names no issue.")).toBeTruthy();
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
    // The page's own read, then the tab's: its own chip, read to the end.
    expect(calls.transcript).toEqual([
      [ctx, "tse_7k2m9q", "everything", { kinds: [] }],
      [ctx, "tse_7k2m9q", "everything", { kinds: ["policy"] }],
    ]);
    const policy = within(
      screen.getByRole("region", { name: "Policy decisions" }),
    );
    expect(policy.getByText("Bash")).toBeTruthy();
    expect(policy.getByText("deny")).toBeTruthy();
    expect(policy.getByText("policy.denied")).toBeTruthy();
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
      screen.getByRole("region", { name: "Recalled context" }),
    );
    expect(context.getByText("engram recall")).toBeTruthy();
    expect(context.queryByText("Bash")).toBeNull();
    cleanup();
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "context" },
    );
    expect(screen.getByText("This run recorded no recall.")).toBeTruthy();
  });

  it("says a list is missing later decisions when a page lies past the one read, and names a subagent's frame without a link (negative)", async () => {
    // `complete` is the read's frame cap. The list used to claim it was whole
    // whenever the cap held, however many pages were left.
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(
          runTranscript({
            cursor: "dDo0MQ",
            entries: [
              {
                ...decided,
                subagent: {
                  chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
                  type: "Explore",
                },
                decision:
                  decided.decision === null
                    ? null
                    : {
                        ...decided.decision,
                        chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
                      },
              },
            ],
          }),
        ),
      },
      { tab: "policy" },
    );
    expect(
      screen.getByText(
        "The transcript read stopped short, so later decisions are missing here.",
      ),
    ).toBeTruthy();
    // The Frames tab reads the run's own chain: seq 41 there is another frame.
    const policy = within(
      screen.getByRole("region", { name: "Policy decisions" }),
    );
    expect(policy.queryByRole("link", { name: "41" })).toBeNull();
    expect(policy.getByText("41")).toBeTruthy();
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
    await expectNoAxe(container);
  });

  it("keeps the page's own main container, and draws four blocks and seven rows with no figure", () => {
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
    // The design's skeleton: shapes only, so nothing reads as a figure.
    expect(screen.getByTestId("run-loading")).toHaveTextContent(
      /^Loading this run$/,
    );
  });
});

it("returns the Run page without waiting for connected provider evidence", async () => {
  const { source } = runSource({
    detail: readOk(runDetail()),
    transcript: readOk(runTranscript()),
  });
  const work = vi.fn(() => new Promise<never>(() => {}));
  source.runs.work = work;
  const page = await Run({
    ctx,
    source,
    runId: "tse_7k2m9q",
    tab: "transcript",
    zoom: null,
    kinds: null,
    frames: null,
    body: null,
    reads: null,
    spine: null,
  });
  // The read has started and never answers, yet the page has returned.
  expect(page).toBeTruthy();
  expect(work).toHaveBeenCalledOnce();
});
