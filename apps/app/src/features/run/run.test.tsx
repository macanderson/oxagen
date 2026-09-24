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
import { formatDuration } from "@/ui/money-format";
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
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
}

const ok = readOk;

afterEach(() => {
  cleanup();
  notFound.mockClear();
});

describe("header", () => {
  it("titles the page with the run's name, keeps the id under it, and draws the model's summary as generated", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Cut the 3.2 release branch");
    expect(h1.className).not.toContain("font-mono");
    expect(screen.getByRole("button", { name: "Copy tse_7k2m9q" })).toBeTruthy();
    // The title is the h1's alone, never repeated in the when line.
    expect(screen.getByTestId("run-when")).not.toHaveTextContent(
      "Cut the 3.2 release branch",
    );
    const summary = screen.getByTestId("generated-summary");
    expect(summary).toHaveTextContent("Cut release/3.2 from main");
    expect(summary).toHaveTextContent("generated");
    expect(summary).toHaveTextContent("Written by z-ai/glm-flash-latest on");
    await expectNoAxe(container);
  });

  it("titles a run with its task reference when no generated name exists, and drops the task chip that would repeat it", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ name: null, summary: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "ENG-4121 cut the 3.2 release",
    );
    expect(screen.queryByTestId("run-task")).toBeNull();
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
    // A sealed run with no seal instant has no wall clock, never "still running".
    expect(stats.queryByText("still running")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("reads sealed from the run's status in the when line, the same status the record actions gate on", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ status: "halted", sealedAt: null }) })),
      transcript: ok(runTranscript()),
    });
    const when = screen.getByTestId("run-when");
    expect(when).toHaveTextContent("ended with no seal recorded");
    expect(when).not.toHaveTextContent("still running");
    cleanup();
    await renderRun({
      detail: ok(runDetail({ run: runRow({ status: "live", sealedAt: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-when")).toHaveTextContent("still running");
  });

  it("titles the run with its harness title when automatic names are off, and says only the summary is off", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            enrichmentEnabled: false,
            name: "Fix the billing proration",
            taskRef: "A derived project label",
            summary: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Fix the billing proration",
    );
    expect(
      screen.getByText(/Automatic summaries are off for this workspace/),
    ).toBeTruthy();
    expect(screen.queryByText(/No summary yet/)).toBeNull();
    expect(
      screen.getByRole("checkbox", {
        name: "Automatic run names and summaries",
      }),
    ).not.toBeChecked();
  });

  it("notes why the last automatic summary failed beside the summary slot", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ summary: null, enrichmentError: "credits_exhausted" }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-summary-failed")).toHaveTextContent(
      "The last automatic summary failed (credits_exhausted).",
    );
    cleanup();
    await renderRun({
      detail: ok(runDetail({ run: runRow({ summary: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-summary-failed")).toBeNull();
  });

  it("labels the operator 'enrolled by' when the name comes from the host's enroller", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ operatorAttribution: "host_enroller" }) }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-operator")).toHaveTextContent(
      "enrolled by Marcus Bell",
    );
    cleanup();
    await renderRun({
      detail: ok(runDetail({ run: runRow({ operatorAttribution: "initiator" }) })),
      transcript: ok(runTranscript()),
    });
    const operator = screen.getByTestId("run-operator");
    expect(operator).toHaveTextContent("by Marcus Bell");
    expect(operator).not.toHaveTextContent("enrolled");
  });

  it("ends the when line and the wall clock at the recorder's end time, not the seal's receipt", async () => {
    const base = runRow();
    const endedAt = new Date(
      new Date(base.startedAt).getTime() + 30 * 60_000,
    ).toISOString();
    await renderRun({
      detail: ok(runDetail({ run: runRow({ endedAt }) })),
      transcript: ok(runTranscript()),
    });
    const ended = screen.getByTestId("run-ended");
    expect(ended).toHaveTextContent("ended");
    expect(ended.querySelector("time")).toHaveAttribute("dateTime", endedAt);
    const stats = within(screen.getByTestId("run-stats"));
    expect(stats.getByText(formatDuration(30 * 60_000, "en"))).toBeTruthy();
    cleanup();
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    // Without an end time the seal still closes the line and the clock.
    expect(screen.queryByTestId("run-ended")).toBeNull();
    expect(screen.getByTestId("run-when")).toHaveTextContent("sealed");
    expect(
      within(screen.getByTestId("run-stats")).queryByText(
        formatDuration(30 * 60_000, "en"),
      ),
    ).toBeNull();
  });

  it("titles a run that carries no name and no task reference by its id in mono (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ name: null, taskRef: null, summary: null }) }),
      ),
      transcript: ok(runTranscript()),
    });
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("tse_7k2m9q");
    expect(h1.className).toContain("font-mono");
    expect(screen.queryByRole("button", { name: "Copy tse_7k2m9q" })).toBeNull();
  });

  it("titles a run whose read failed by the id the URL named", async () => {
    await renderRun({
      detail: readError("run_index_unavailable", 503),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "tse_7k2m9q",
    );
  });

  it("draws the agent, status and tier chips, and the rig the run ran on", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const chips = within(screen.getByTestId("run-chips"));
    expect(chips.getByTestId("run-tier")).toBeTruthy();
    expect(chips.getByTestId("run-task")).toHaveTextContent("ENG-4121");
    const rig = within(screen.getByTestId("run-rig"));
    expect(rig.getByText("claude-sonnet-5")).toHaveAttribute(
      "title",
      "anthropic sonnet",
    );
    // The session recorded its harness, so the rig names it and its version.
    expect(rig.getByText("Claude Code")).toBeTruthy();
    expect(rig.getByText("version 2.1.0")).toBeTruthy();
    // The session row holds no effort or mode, so the rig says so.
    expect(rig.getByText("effort not recorded")).toBeTruthy();
    // No frame recorded thinking, so the rig draws no thinking chip.
    expect(rig.queryByTestId("run-thinking")).toBeNull();
    expect(rig.getByText("mode not recorded")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("reads effort, permission mode, tokens and cost from the session row", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            effort: "high",
            thinking: true,
            permissionMode: "acceptEdits",
            reportedTokens: {
              input: 1200,
              output: 340,
              cacheRead: 56000,
              cacheWrite: 7800,
            },
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    const rig = within(screen.getByTestId("run-rig"));
    expect(rig.getByTestId("run-effort")).toHaveTextContent("effort high");
    expect(rig.getByTestId("run-thinking")).toHaveTextContent("thinking on");
    expect(rig.getByTestId("run-permission-mode")).toHaveTextContent(
      "mode acceptEdits",
    );
    const usage = within(screen.getByTestId("run-usage"));
    expect(usage.getByText("1,200 input")).toBeTruthy();
    expect(usage.getByText("340 output")).toBeTruthy();
    expect(usage.getByText("56,000 cache read")).toBeTruthy();
    expect(usage.getByText("7,800 cache write")).toBeTruthy();
    // The row carries a finalized cost, so it is not marked as reported.
    expect(usage.getByTestId("run-usage-cost")).toHaveTextContent("$4.13");
    expect(usage.queryByText("agent reported")).toBeNull();
  });

  it("marks an agent-reported cost and says when no tokens were recorded", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            cost: null,
            reportedCost: { micros: "250000", currency: "USD", basis: null },
            reportedTokens: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    const usage = within(screen.getByTestId("run-usage"));
    expect(usage.getByText("tokens not recorded")).toBeTruthy();
    expect(usage.getByTestId("run-usage-cost")).toHaveTextContent("$0.25");
    expect(usage.getByText("agent reported")).toBeTruthy();
  });

  it("draws the repository, branch, local directory and subagents the work frames recorded", async () => {
    const repository = {
      host: "github.com",
      owner: "macanderson",
      name: "oxagen",
      url: "https://github.com/macanderson/oxagen",
      connected: true,
    };
    const checkout = (
      ref: string,
      path: string,
      branch: string,
      lastSeq: string,
    ) => ({
      ref,
      path,
      branch,
      headSha: null,
      remoteDigest: null,
      repository,
      firstSeq: "1",
      lastSeq,
    });
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok({
        runId: "tse_7k2m9q",
        machine: null,
        checkouts: [
          checkout("co_1", "/Users/mac/Projects/oxagen", "main", "9"),
          checkout(
            "co_2",
            "/Users/mac/Projects/.worktrees/oxagen/run-header-facts",
            "fix/run-header-facts",
            "40",
          ),
        ],
        diffs: [],
        pullRequests: [],
        subagents: [
          {
            id: "a0182b6cd3a21d284",
            type: "Explore",
            firstSeq: "12",
            lastSeq: "30",
            stopped: true,
          },
          {
            id: "b77c01e9f2d4a8c10",
            type: null,
            firstSeq: "31",
            lastSeq: "31",
            stopped: false,
          },
        ],
        complete: true,
        warnings: [],
      }),
    });
    const strip = within(await screen.findByTestId("run-checkout"));
    // The checkout touched last (seq 40 beats seq 9) is the one shown.
    expect(
      strip.getByRole("link", { name: "macanderson/oxagen" }),
    ).toHaveAttribute("href", "https://github.com/macanderson/oxagen");
    expect(strip.getByTestId("run-branch")).toHaveTextContent(
      "fix/run-header-facts",
    );
    expect(
      strip.getByText("/Users/mac/Projects/.worktrees/oxagen/run-header-facts"),
    ).toBeTruthy();
    expect(strip.getByText("1 more checkout")).toBeTruthy();
    const subagents = within(screen.getByTestId("run-subagents"));
    expect(subagents.getByTitle("a0182b6cd3a21d284")).toHaveTextContent(
      "Explore",
    );
    // A sealed run whose subagent never stopped says the stop is missing.
    expect(subagents.getByTitle("b77c01e9f2d4a8c10")).toHaveTextContent(
      "type not recorded",
    );
    expect(subagents.getByText("no stop recorded")).toBeTruthy();
  });

  it("draws a PR both reads carry once, and keeps the PR only the outputs recorded", async () => {
    const repo = {
      host: "github.com",
      owner: "Acme",
      name: "core",
      url: "https://github.com/Acme/core",
      connected: true,
    };
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      outputs: ok(
        runOutputs([
          runOutputNode({
            seq: "20",
            kind: "pr",
            name: "#41",
            where: "acme/core",
            state: "open",
            note: "https://github.com/acme/core/pull/41",
            stat: null,
          }),
          runOutputNode({
            seq: "30",
            kind: "pr",
            name: "#7",
            where: "acme/tools",
            state: "open",
            note: "https://github.com/acme/tools/pull/7",
            stat: null,
          }),
        ]),
      ),
      work: ok({
        runId: "tse_7k2m9q",
        machine: null,
        checkouts: [],
        diffs: [],
        pullRequests: [
          {
            repository: repo,
            number: 41,
            url: `${repo.url}/pull/41`,
            title: "Cut the branch",
            state: "merged",
            headSha: null,
            headRef: "release/3.2",
            association: "recorded",
            closingIssues: null,
            checkoutRefs: [],
            observedAt: "2026-09-23T10:00:00.000Z",
            current: true,
            ci: null,
            diff: null,
          },
        ],
        subagents: [],
        complete: true,
        warnings: [],
      }),
    });
    const strip = within(await screen.findByTestId("run-checkout"));
    const pulls = strip.getAllByTestId("run-pull");
    expect(pulls).toHaveLength(2);
    expect(pulls[0]).toHaveTextContent("#41merged");
    expect(pulls[1]).toHaveTextContent("#7acme/tools");
    expect(strip.queryByText("no pull request")).toBeNull();
  });

  it("says the checkout was not read when the work read fails", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: readError("unavailable", 503),
    });
    const strip = within(await screen.findByTestId("run-checkout"));
    expect(strip.getByText("checkout not read")).toBeTruthy();
    expect(strip.getByText("mac-studio.local")).toBeTruthy();
    expect(
      within(screen.getByTestId("run-subagents")).getByText(
        "subagents not read",
      ),
    ).toBeTruthy();
  });

  it("names the operator and the machine the run ran on, with a copy button for the host", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const when = within(screen.getByTestId("run-when"));
    expect(when.getByText("Marcus Bell")).toBeTruthy();
    // The id is a key, not a label: it is in the hover card, never in the line.
    expect(when.queryByText("prn_marcusbell")).toBeNull();
    await userEvent.hover(when.getByTestId("run-operator-name"));
    expect(when.getByTestId("operator-card")).toHaveTextContent(
      "prn_marcusbell",
    );
    const checkout = within(await screen.findByTestId("run-checkout"));
    expect(checkout.getByText("mac-studio.local")).toBeTruthy();
    expect(
      checkout.getByRole("button", { name: "Copy mac-studio.local" }),
    ).toBeTruthy();
    // The default work read recorded no checkout.
    expect(checkout.getByText("repository not recorded")).toBeTruthy();
    expect(checkout.getByText("branch not recorded")).toBeTruthy();
    expect(checkout.getByText("path not recorded")).toBeTruthy();
    expect(
      within(screen.getByTestId("run-subagents")).getByText(
        "no subagents recorded",
      ),
    ).toBeTruthy();
    const machine = within(screen.getByTestId("run-machine"));
    expect(
      machine.getByText("Session machine facts not recorded."),
    ).toBeTruthy();
    expect(
      machine.getByText(
        "Enrollment hostname and facts: darwin · 15.6 · arm64 · v24.4.0",
      ),
    ).toBeTruthy();
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
    const machine = within(screen.getByTestId("run-machine"));
    expect(
      machine.getByText("Recorded in this session: linux · 6.12 · x64"),
    ).toBeTruthy();
    expect(
      machine.getByText(
        "Enrollment hostname and facts: darwin · 15.6 · arm64 · v24.4.0",
      ),
    ).toBeTruthy();
    expect(
      machine.queryByText("Session machine facts not recorded."),
    ).toBeNull();
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
      within(await screen.findByTestId("run-checkout")).getByText(
        "machine not recorded",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("The evidence ledger records no host for a run."),
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
    expect(operator).toHaveTextContent("by not recorded");
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
    expect(screen.getByTestId("run-resummarize")).toBeTruthy();
    expect(screen.getByTestId("run-export")).toBeTruthy();
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
    expect(screen.getByTestId("export-no-role")).toHaveTextContent(
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
    expect(screen.queryByTestId("export-no-role")).toBeNull();
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
    const tabs = screen.getByRole("navigation", { name: "Run sections" });
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
      { tab: "proof" },
    );
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(calls.chain).toHaveLength(0);
  });

  it("lists the seven tabs in the spec's order, each with its count", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const tabs = within(
      screen.getByRole("navigation", { name: "Run sections" }),
    );
    expect(
      tabs.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(
      ["transcript", "issues", "actions", "cost", "policy", "context", "chain"]
        .map((tab) => `/acme/core-platform/runs/tse_7k2m9q?tab=${tab}`)
        // The Transcript tab keeps the zoom it was opened at.
        .map((href, index) => (index === 0 ? `${href}&zoom=steps` : href)),
    );
    expect(tabs.getByRole("link", { name: /Transcript/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("run-tab-count-issues")).toHaveTextContent("1");
    expect(screen.getByTestId("run-tab-count-actions")).toHaveTextContent("0");
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
        screen.getByRole("link", { name: /Governed actions/ }),
      ).toHaveAttribute("aria-current", "page");
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

  it("names the store that is down and says runs kept recording (negative)", async () => {
    const { container } = await renderRun({ detail: DOWN });
    expect(screen.getByText(/frame_store_unreachable/)).toBeTruthy();
    expect(screen.getByText(/runs kept recording/)).toBeTruthy();
    await expectNoAxe(container);
  });

  it("names the permission a denied viewer lacks (negative)", async () => {
    await renderRun({ detail: DENIED });
    expect(screen.getByText(/Your roles do not include run.read/)).toBeTruthy();
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
    expect(stats.getByText("128,343")).toBeTruthy();
    expect(stats.getByText("1")).toBeTruthy();
    expect(stats.getByText("$4.13")).toBeTruthy();
    expect(stats.getByText("Finalized rollup (gateway_observed)")).toBeTruthy();
    // 29% of $4.131265 that the rollup did not count as productive.
    expect(stats.getByText("$1.20")).toBeTruthy();
    expect(stats.getByText("derived from the productive share")).toBeTruthy();
    expect(stats.getByText("83%")).toBeTruthy();
    await expectNoAxe(container);
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

  it("counts the session's reported tokens before the rollup rebuilds the run", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            reportedTokens: {
              input: 1000,
              output: 200,
              cacheRead: 3000,
              cacheWrite: 400,
            },
          }),
        }),
      ),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: null })),
    });
    const stats = within(screen.getByTestId("run-stats"));
    expect(stats.getByText("4,600")).toBeTruthy();
    expect(stats.getByText("provisional until the rollup")).toBeTruthy();
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
    expect(changes.getByText("41 added, 6 removed in 1 file")).toBeTruthy();
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
    expect(changes.getByText("none recorded")).toBeTruthy();
  });

  it("splits the spend by model, each row with its calls and its money", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const spend = within(screen.getByTestId("run-spend"));
    expect(spend.getByText("claude-opus-5")).toBeTruthy();
    expect(spend.getByText("54 calls")).toBeTruthy();
    expect(spend.getByText("$4.13")).toBeTruthy();
  });

  it("says the rollup is not built yet rather than drawing an empty split (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: null })),
    });
    expect(screen.queryByTestId("run-spend")).toBeNull();
    expect(
      screen.getByText("No cost rollup yet. It is built after the run seals."),
    ).toBeTruthy();
  });

  it("draws a live run's provisional spend by model before the rollup exists, and labels it", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      cost: ok(
        runCost({
          rollup: null,
          provisional: {
            byModel: [
              {
                model: "claude-sonnet-5",
                provider: "anthropic",
                calls: 3,
                cost: {
                  micros: "2500000",
                  currency: "USD",
                  basis: "client_attested",
                },
              },
            ],
            toolCalls: 6,
            asOf: "2026-09-23T10:00:00.000Z",
          },
        }),
      ),
    });
    const spend = within(screen.getByTestId("run-spend"));
    expect(spend.getByText("claude-sonnet-5")).toBeTruthy();
    expect(spend.getByText("3 calls")).toBeTruthy();
    expect(spend.getByText("$2.50")).toBeTruthy();
    expect(screen.getByTestId("run-spend-provisional").textContent).toBe(
      "Provisional until the rollup. Priced from the cost each call reported.",
    );
    expect(
      screen.queryByText("No cost rollup yet. It is built after the run seals."),
    ).toBeNull();
  });

  it("draws no provisional label once the rollup exists (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-spend")).toBeTruthy();
    expect(screen.queryByTestId("run-spend-provisional")).toBeNull();
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

  it("keeps the page's own main container and header, rather than exporting the skeleton alone", () => {
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
    expect(main).toContainElement(screen.getByRole("heading", { name: "Run" }));
    expect(main).toContainElement(screen.getByRole("status"));
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
