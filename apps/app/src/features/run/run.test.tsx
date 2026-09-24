// @vitest-environment jsdom
// The Run page over a fake DataSource: the header, the tab chooser, and each
// of the four sections in its ok, empty, denied and error states, with an axe
// check on every render.
//
// Two rules the tests hold the page to, because breaking either is how a
// console starts lying: a tab's own heavy read (the chain, the per-turn
// ledger, the frames page) happens only when that tab is open, and a value the
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
import type { PriceBook } from "@/data/contracts/spend";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import { agentDetail } from "../agents/agents.builders";
import { TOKEN_CLASSES } from "./metrics";
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
  runTurns,
  runWork,
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
  sealRun: vi.fn(),
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
    await Promise.resolve();
  });
  return { container, calls };
}

const ok = readOk;

/**
 * Today's price book for the run's model: $150 a million for every class,
 * nowhere near the rates the builders' recorded figures came from, as after a
 * rate change since the run.
 */
const todaysBook = (): PriceBook => ({
  at: "2026-09-15T00:00:00.000Z",
  entries: TOKEN_CLASSES.map((tokenClass) => ({
    provider: "anthropic",
    model: "claude-opus-5",
    modelAliases: [],
    region: null,
    tokenClass,
    unit: "token" as const,
    ratePerMillion: { micros: "150000000", currency: "USD" },
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveTo: null,
    source: "list" as const,
    negotiated: false,
  })),
});

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
    // Tokens, prompts, cost, wasted and cache hit: nothing backs any. The
    // wall clock is backed by the run's recorded start, and keeps counting.
    expect(stats.getAllByText("not recorded")).toHaveLength(5);
    expect(screen.getByTestId("run-wall-ticking")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("ticks a live run's wall clock once a second from its start", async () => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ["setInterval", "clearInterval", "Date"],
    });
    try {
      await renderRun(
        {
          detail: ok(
            runDetail({
              run: runRow({
                status: "live",
                sealedAt: null,
                endedAt: null,
                startedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
              }),
            }),
          ),
          transcript: ok(runTranscript()),
        },
        { tab: "cost" },
      );
      const wall = within(screen.getByTestId("run-stat-wall"));
      // Three days read as hours, short enough for the tile.
      expect(wall.getByText("72:00:00")).toBeTruthy();
      expect(
        within(screen.getByTestId("inst-wall-value")).getByText("72:00:00"),
      ).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(wall.getByText("72:00:02")).toBeTruthy();
      expect(
        within(screen.getByTestId("inst-wall-value")).getByText("72:00:02"),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a sealed run's wall clock at its end (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-wall-ticking")).toBeNull();
  });

  it("shows the harness title when automatic names are disabled", async () => {
    // With enrichment off, get_run already swaps Oxagen's name for the title
    // the harness gave the session (`resolveRun`). The header shows what it
    // is sent; dropping it hid the one title the operator chose to keep.
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
    expect(screen.getByTestId("run-when")).toHaveTextContent(
      "Fix the billing proration",
    );
    expect(screen.getByTestId("run-when")).not.toHaveTextContent(
      "A derived project label",
    );
    expect(
      within(screen.getByTestId("run-summary")).getByRole("checkbox", {
        name: "Automatic run names and summaries",
      }),
    ).not.toBeChecked();
  });

  it("falls back to the task label when names are disabled and the harness gave none", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            enrichmentEnabled: false,
            name: null,
            taskRef: "A derived project label",
            summary: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-when")).toHaveTextContent(
      "A derived project label",
    );
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

  it("says each pull request's state beside it, as the work read took it from the forge", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(runWork()),
    });
    const checkout = within(await screen.findByTestId("run-checkout"));
    const states = checkout.getAllByTestId("run-pull-state");
    expect(states.map((s) => s.getAttribute("data-state"))).toEqual(["open"]);
    expect(states[0]).toHaveTextContent("open");
  });

  it("links a pull request only the frames recorded, a GitLab merge request included, with status unknown", async () => {
    const gitlab = "https://gitlab.com/acme/platform/web/-/merge_requests/9";
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(runWork()),
      outputs: ok(
        runOutputs([
          // The work read already holds #482; this node is the same PR.
          runOutputNode({
            seq: "300",
            kind: "pr",
            name: "#482",
            where: "acme/platform",
            state: "open",
            note: "https://github.com/acme/platform/pull/482",
            stat: null,
          }),
          runOutputNode({
            seq: "301",
            kind: "pr",
            name: "#9",
            where: "acme/platform/web",
            state: "open",
            note: gitlab,
            stat: null,
          }),
        ]),
      ),
    });
    const checkout = within(await screen.findByTestId("run-checkout"));
    // #482 is listed once, from the work read, with its live state.
    expect(
      checkout.getAllByRole("link", { name: "acme/platform#482" }),
    ).toHaveLength(1);
    const mr = checkout.getByRole("link", { name: "acme/platform/web#9" });
    expect(mr).toHaveAttribute("href", gitlab);
    expect(mr).toHaveAttribute("target", "_blank");
    expect(
      checkout
        .getAllByTestId("run-pull-state")
        .map((s) => s.getAttribute("data-state")),
    ).toEqual(["open", "unknown"]);
    expect(checkout.getByText("status unknown")).toBeTruthy();
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

  it("says parked in the header status while a call on a live run waits for approval", async () => {
    const { container } = await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", sealedAt: null }) }),
      ),
      transcript: ok(runTranscript()),
      approvals: ok({ items: [approval()], more: false }),
    });
    const status = screen.getByTestId("run-status");
    // A live region, so a refresh that parks a call is heard, not only seen.
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(/^parked$/);
    expect(status.querySelector("[data-pulse]")).toBeNull();
    await expectNoAxe(container);
  });

  it("says paused over parked, and offers Resume once, with the run's other controls", async () => {
    const { container } = await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            status: "live",
            sealedAt: null,
            source: "ledger",
            ingressPaused: true,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
      approvals: ok({ items: [approval()], more: false }),
    });
    expect(screen.getByTestId("run-status")).toHaveTextContent(/^paused$/);
    expect(screen.getByTestId("run-paused")).toHaveTextContent("Paused.");
    // Resume sits with Pause and Cancel in the header; the banner only says
    // why the run is waiting.
    expect(screen.getByTestId("run-resume")).toHaveTextContent("Resume run");
    expect(screen.getAllByRole("button", { name: /resume/i })).toHaveLength(1);
    expect(screen.getByTestId("run-paused").querySelector("button")).toBeNull();
    await expectNoAxe(container);
  });

  it("reads an ended run's outcome, not parked, whatever is still parked on it (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      approvals: ok({ items: [approval()], more: false }),
    });
    const status = screen.getByTestId("run-status");
    expect(status).toHaveTextContent(/^completed$/);
    expect(status).not.toHaveTextContent("parked");
  });

  it("reads live on a live run with nothing parked and ingress open (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", sealedAt: null }) }),
      ),
      transcript: ok(runTranscript()),
      approvals: ok({ items: [], more: false }),
    });
    expect(screen.getByTestId("run-status")).toHaveTextContent(/^live$/);
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

  it("names the harness the agent registry holds when the session recorded none, and says no version was captured", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ harness: null }) })),
      transcript: ok(runTranscript()),
      agent: ok(agentDetail({ identity: { harness: "codex" } })),
    });
    const rig = within(screen.getByTestId("run-rig"));
    expect(rig.getByText("Codex")).toBeTruthy();
    expect(rig.getByText("version not captured")).toBeTruthy();
    // The summary's card names the agent the registry returned, then its harness.
    expect(screen.getByTestId("run-involved")).toHaveTextContent(
      "Release bot · Codex",
    );
  });

  it("says the agent is not recorded when the run names none, and reads no agent (negative)", async () => {
    const { calls } = await renderRun({
      detail: ok(runDetail({ run: runRow({ agentKey: null }) })),
      transcript: ok(runTranscript()),
      roster: ok(runRoster()),
    });
    expect(calls.agent).toHaveLength(0);
    const chips = screen.getByTestId("run-chips");
    expect(chips).toHaveTextContent("not recorded");
    expect(chips).not.toHaveTextContent("runs 30d");
    expect(screen.getByTestId("run-involved")).toHaveTextContent(
      "not recorded",
    );
  });

  it("leaves the 30-day figures off when the Agents read fails, and the spend off when the row carries none (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      roster: readError("agents_unreachable", 502),
    });
    expect(screen.getByTestId("run-chips")).not.toHaveTextContent("runs 30d");
    cleanup();
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      roster: ok(runRoster({ spend30d: null })),
    });
    const chips = screen.getByTestId("run-chips");
    expect(chips).toHaveTextContent("Claude Code · 212 runs 30d");
    expect(chips).not.toHaveTextContent("$612.48");
  });

  it("draws the pull requests the outputs recorded when the work read fails, and says the repository was not captured (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: readError("github_unreachable", 502),
      outputs: ok(
        runOutputs([
          runOutputNode({ seq: "300", kind: "pr", name: "acme/platform#482" }),
          // A pull request the spine holds with no frame of its own.
          runOutputNode({ seq: null, kind: "pr", name: "acme/docs#17" }),
        ]),
      ),
    });
    const checkout = within(await screen.findByTestId("run-checkout"));
    expect(
      checkout.getByText("repository and branch not captured"),
    ).toBeTruthy();
    expect(checkout.getByText("acme/platform#482")).toBeTruthy();
    expect(checkout.getByText("acme/docs#17")).toBeTruthy();
    expect(checkout.queryByText("no pull request")).toBeNull();
    // No checkout was read, so no path is offered to copy.
    expect(checkout.queryByTestId("run-checkout-path")).toBeNull();
    expect(checkout.getByTestId("run-machine")).toHaveTextContent(
      "mac-studio.local",
    );
  });

  it("links a branch that heads no pull request to its tree on the forge", async () => {
    const base = runWork();
    const [checkout] = base.checkouts;
    if (checkout === undefined) throw new Error("the builder holds a checkout");
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(
        runWork({ checkouts: [{ ...checkout, branch: "feature/fix-tags" }] }),
      ),
    });
    const strip = within(await screen.findByTestId("run-checkout"));
    expect(
      strip
        .getByRole("link", { name: "feature/fix-tags" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/platform/tree/feature/fix-tags");
  });

  it("draws a repository on a forge Oxagen cannot name as text, never as a link (negative)", async () => {
    const base = runWork();
    const [checkout] = base.checkouts;
    if (checkout === undefined) throw new Error("the builder holds a checkout");
    const gitlab = {
      host: "gitlab.com",
      owner: "acme",
      name: "platform",
      url: "https://gitlab.com/acme/platform",
      connected: false,
    };
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(
        runWork({
          checkouts: [{ ...checkout, repository: gitlab }],
          pullRequests: [],
        }),
      ),
    });
    const strip = within(await screen.findByTestId("run-checkout"));
    expect(strip.getByText("acme/platform")).toBeTruthy();
    expect(strip.queryByRole("link", { name: "acme/platform" })).toBeNull();
    expect(strip.queryByRole("link", { name: "release/3.2" })).toBeNull();
    expect(strip.getByText("no pull request")).toBeTruthy();
  });

  it("draws a branch whose repository nobody recorded as text beside the not-captured chip (negative)", async () => {
    const base = runWork();
    const [checkout] = base.checkouts;
    if (checkout === undefined) throw new Error("the builder holds a checkout");
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(
        runWork({
          machine: null,
          checkouts: [{ ...checkout, repository: null }],
          pullRequests: [],
        }),
      ),
    });
    const strip = within(await screen.findByTestId("run-checkout"));
    // The branch is recorded and drawn, so the chip names only the repository
    // as missing rather than contradicting the branch beside it.
    expect(strip.getByText("repository not captured")).toBeTruthy();
    expect(strip.queryByText("repository and branch not captured")).toBeNull();
    expect(strip.getByText("release/3.2")).toBeTruthy();
    expect(strip.queryByRole("link")).toBeNull();
    // The work read named no machine, so the path is the run row's host.
    expect(strip.getByTestId("run-checkout-path")).toHaveTextContent(
      "mac-studio.local:~/src/platform/.worktrees/release-3.2",
    );
  });

  it("copies the checkout path and says so, and says the copy failed when the clipboard refuses (negative)", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      await renderRun({
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        work: ok(runWork()),
      });
      const strip = within(await screen.findByTestId("run-checkout"));
      const path = strip.getByTestId("run-checkout-path");
      await act(async () => {
        fireEvent.click(path);
        await Promise.resolve();
      });
      const text = "mac-studio.local:~/src/platform/.worktrees/release-3.2";
      expect(writeText).toHaveBeenCalledWith(text);
      expect(strip.getByRole("status")).toHaveTextContent(`Copied ${text}`);
      writeText.mockImplementationOnce(() =>
        Promise.reject(new Error("NotAllowedError")),
      );
      await act(async () => {
        fireEvent.click(path);
        await Promise.resolve();
      });
      expect(strip.getByRole("status")).toHaveTextContent(
        "Copy failed. Select the text and copy it.",
      );
      // The path stays on screen to select by hand.
      expect(path).toHaveTextContent(text);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("leaves the title off the when line when the run has neither a name nor a task reference (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ name: null, taskRef: null, summary: null }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-when")).toHaveTextContent(/^started /);
    expect(screen.queryByTestId("run-task")).toBeNull();
  });

  it("lists the gaps the seal recorded, in words, under the header", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ completenessGaps: ["digest_only", "chain_break"] }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-gaps")).toHaveTextContent(
      "The seal recorded these gaps in the record: digests kept, bodies not retained, the hash chain does not hold end to end",
    );
    cleanup();
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-gaps")).toBeNull();
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

  it("disables only Steer on a live run whose harness carries no mid-session prompt", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ status: "live", steerBlock: "no_prompt_carrier" }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-steer")).toBeDisabled();
    for (const command of ["pause", "resume", "cancel"]) {
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
    // The per-turn ledger belongs to the Cost tab.
    expect(calls.turns).toHaveLength(0);
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
    // Transcript counts the rows its feed opens with, the entries its header
    // line names, not the run's steps.
    const entries = /(\d+) entries/.exec(
      screen.getByTestId("transcript").textContent,
    )?.[1];
    expect(entries).toBeDefined();
    expect(screen.getByTestId("run-tab-count-transcript")).toHaveTextContent(
      entries ?? "",
    );
    expect(screen.getByTestId("run-tab-count-transcript").textContent).not.toBe(
      String(runDetail().run.steps),
    );
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

  it("names the parked marker to a screen reader and wires the open tab to its panel", async () => {
    const { container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        approvals: ok({ items: [approval()], more: false }),
      },
      { tab: "cost" },
    );
    expect(screen.getByTestId("run-tab-parked-actions")).toHaveTextContent(
      "A call is parked for approval",
    );
    // The marker is part of each marked tab's name, so the fact is read with
    // the tab: Governed actions and Policy, where the parked call is.
    expect(
      screen.getAllByRole("tab", { name: /A call is parked for approval/ }),
    ).toHaveLength(2);
    const open = screen.getByRole("tab", { selected: true });
    const panel = screen.getByRole("tabpanel");
    expect(open).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", open.id);
    expect(panel).toHaveAttribute("data-testid", "run-tab-cost");
    await expectNoAxe(container);
  });

  it("points no closed tab at a panel the page did not draw, and draws no marker with nothing parked (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      approvals: ok({ items: [], more: false }),
    });
    for (const tab of screen.getAllByRole("tab", { selected: false }))
      expect(tab).not.toHaveAttribute("aria-controls");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.queryByText("A call is parked for approval")).toBeNull();
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
  it("draws the header line, the seven chips and the feed from the page's one whole-run read", async () => {
    const { container, calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript" },
    );
    // The tab makes no read of its own: the figures and the feed come from
    // the same read, so a chip's count is the count of the rows it shows.
    expect(calls.transcript).toHaveLength(1);
    const tab = screen.getByRole("region", { name: "Transcript" });
    const chips = within(screen.getByTestId("transcript-chips"))
      .getAllByRole("button", { pressed: true })
      .map((chip) => chip.getAttribute("data-testid"));
    expect(chips).toEqual([
      "chip-prompt",
      "chip-responses",
      "chip-thinking",
      "chip-tools",
      "chip-usage",
      "chip-recall",
      "chip-seal",
    ]);
    expect(within(tab).getByTestId("transcript-you")).toHaveTextContent(
      "Cut the 2026.9.2 release candidate.",
    );
    expect(within(tab).getAllByTestId("tx-row").length).toBeGreaterThan(1);
    expect(within(tab).getAllByTestId("tx-tool-name").length).toBeGreaterThan(
      0,
    );
    await expectNoAxe(container);
  });

  it("reads live in the header line of a live run", async () => {
    await renderRun(
      {
        detail: ok(runDetail({ run: runRow({ status: "live" }) })),
        transcript: ok(mockupTranscript()),
      },
      { tab: "transcript" },
    );
    expect(
      within(screen.getByTestId("transcript")).getAllByText("live").length,
    ).toBeGreaterThan(0);
  });

  // Carried from #4026, which added rewind and to-the-end buttons and the
  // mockup's speeds to the turn-and-step transport this page replaced. The
  // feed's transport counts rows drawn (`at / total`) rather than frames.
  it("rewinds to the first row, jumps to the last, and offers the mockup's four speeds", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript" },
    );
    const readout = screen.getByTestId("transport-readout");
    const total = /\/ (\d+)/.exec(readout.textContent)?.[1];
    if (total === undefined) throw new Error("no total in the readout");
    const rewind = screen.getByRole("button", { name: "Rewind" });
    const end = screen.getByRole("button", { name: "To the end" });
    // A sealed run opens at its end.
    expect(end).toBeDisabled();
    fireEvent.click(rewind);
    expect(readout).toHaveTextContent(`0 / ${total}`);
    expect(rewind).toBeDisabled();
    expect(screen.getByRole("button", { name: "Step back" })).toBeDisabled();
    fireEvent.click(end);
    expect(readout).toHaveTextContent(`${total} / ${total}`);
    const speeds = within(
      screen.getByRole("group", { name: "Playback speed" }),
    ).getAllByRole("button");
    expect(speeds.map((button) => button.textContent)).toEqual([
      "1×",
      "2×",
      "3×",
      "6×",
    ]);
    expect(speeds[0]).toHaveAttribute("aria-pressed", "true");
    const six = speeds[3];
    if (six === undefined) throw new Error("no 6× speed button");
    fireEvent.click(six);
    expect(speeds[3]).toHaveAttribute("aria-pressed", "true");
    expect(speeds[0]).toHaveAttribute("aria-pressed", "false");
  });

  it("draws no zoom tabs, and puts no zoom on the Transcript tab's link", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript" },
    );
    for (const name of ["Turns", "Steps", "Everything"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("tab", { name: /Transcript/ })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript",
    );
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
});

describe("cost", () => {
  it("opens on Model fit, then the instruments, and prices the token classes with the basis and price entries", async () => {
    const { container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        cost: ok(runCost()),
      },
      { tab: "cost" },
    );
    const tab = screen.getByTestId("cost-tab");
    // Model fit is first on the tab (pages/run.md, Model fit).
    const fit = within(tab).getByTestId("fit-model-card");
    const instruments = within(tab).getByTestId("run-instruments");
    expect(fit.compareDocumentPosition(instruments) & 4).toBe(4);
    // The Tokens figure and the token classes' total row are one total.
    expect(screen.getByTestId("token-class-total-tokens")).toHaveTextContent(
      "128,343",
    );
    expect(
      within(screen.getByTestId("run-stat-tokens")).getByText("128,343"),
    ).toBeTruthy();
    expect(tab).toHaveTextContent("gateway_observed");
    expect(tab).toHaveTextContent("prc_01k4qj9e");
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
    expect(screen.queryByTestId("token-class-row")).toBeNull();
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

  it("keeps a live run with no frames yet on its empty state, following quietly where the browser cannot stream", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ frames: 0, status: "live" }) })),
    });
    expect(screen.getByTestId("run-empty")).toBeTruthy();
    // jsdom has no EventSource, so the follower mounts and says nothing.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the viewer's access request is waiting, names it, and reads nothing else (negative)", async () => {
    const { container, calls } = await renderRun({
      detail: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "areq_01k4qj9e",
      },
    });
    const state = within(screen.getByTestId("run-pending"));
    expect(
      state.getByRole("heading", { name: "Your access request is waiting" }),
    ).toBeTruthy();
    expect(state.getByText(/The request is areq_01k4qj9e\./)).toBeTruthy();
    // A pending read offers no action: the request is already made.
    expect(state.queryByRole("button")).toBeNull();
    expect(state.queryByRole("link")).toBeNull();
    expect(calls.transcript).toHaveLength(0);
    expect(notFound).not.toHaveBeenCalled();
    await expectNoAxe(container);
  });
});

describe("chips", () => {
  it("opens with the chips an older link's filter named, and still reads the whole run once", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript", kinds: "errors,tools" },
    );
    expect(calls.transcript).toHaveLength(1);
    expect(calls.transcript[0]?.[2]).toBe("everything");
    expect(calls.transcript[0]?.[3]).toEqual({ kinds: [] });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("chip-errors")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("drops a word the contract does not publish rather than refusing the page (negative)", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript", kinds: "proof,tools" },
    );
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByTestId("chip-proof")).toBeNull();
  });

  // Carried from #4026: turning every chip off reads nothing more and says
  // how to get the run back. The chips filter the one read in the browser.
  it("reads nothing more when every chip is off, and says how to get the run back", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript" },
    );
    fireEvent.click(screen.getByTestId("chip-all"));
    expect(calls.transcript).toEqual([
      [ctx, "tse_7k2m9q", "everything", { kinds: [] }],
    ]);
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Nothing to show with these filters.",
    );
    expect(screen.queryAllByTestId("tx-row")).toHaveLength(0);
    expect(screen.getByTestId("chip-all")).toHaveTextContent("all");
  });

  it("opens every chip off from a link that says none, and keeps none on the tab's link", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript", kinds: "none" },
    );
    expect(calls.transcript).toHaveLength(1);
    expect(calls.transcript[0]?.[3]).toEqual({ kinds: [] });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("tab", { name: /Transcript/ })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&kinds=none",
    );
  });

  it("carries the chips on the Transcript tab's own link, so one filter has one URL", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(mockupTranscript()) },
      { tab: "transcript", kinds: "errors,tools" },
    );
    expect(screen.getByRole("tab", { name: /Transcript/ })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&kinds=tools%2Cerrors",
    );
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
  it("reads the calls parked on this run for the tab's dot on every tab, and the decided ones only on Governed actions", async () => {
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
    expect(calls.resolvedApprovals).toHaveLength(0);
    expect(screen.queryByTestId("run-tab-parked-actions")).toBeNull();
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
});

describe("cost", () => {
  it("reads the rollup once, and lays out the per-turn ledger from its own one get_run_turns read", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        cost: ok(runCost()),
        transcript: ok(mockupTranscript()),
        turns: ok(runTurns()),
      },
      { tab: "cost" },
    );
    expect(calls.cost).toHaveLength(1);
    // The page's figures read the one transcript, at no other zoom.
    expect(calls.transcript.map((call) => call[2])).toEqual(["everything"]);
    expect(calls.turns).toEqual([[ctx, "tse_7k2m9q"]]);
    // Two turns; the second carries no cost, so it draws no bar.
    expect(screen.getAllByTestId("waterfall-row")).toHaveLength(2);
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
            transcriptEntry({
              seq: "1",
              endSeq: "1",
              type: "turn_start",
              kind: "frame",
              kinds: [],
            }),
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
    // The rollup's productive ratio is a share of steps, not of cost, so the
    // Wasted figure is not recorded rather than a share of $4.13.
    expect(stat("wasted").getByText("not recorded")).toBeTruthy();
    expect(
      stat("wasted").getByText(
        "the cost of steps that did not advance the task",
      ),
    ).toBeTruthy();
    expect(stat("wasted").queryByText("$1.20")).toBeNull();
    expect(stat("cache").getByText("83%")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("counts every prompt after the first as corrective, in the approval hue above two", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(
        runTranscript({
          entries: ["1", "2", "3"].map((seq) =>
            transcriptEntry({
              seq,
              endSeq: seq,
              type: "turn_start",
              kind: "frame",
              kinds: [],
            }),
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
          entries: [
            transcriptEntry({ type: "turn_start", kind: "frame", kinds: [] }),
          ],
        }),
      ),
    });
    expect(
      within(screen.getByTestId("run-stat-prompts")).getByText("1+"),
    ).toBeTruthy();
  });

  it("prints the agent's own report as provisional when nothing metered the run (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            cost: null,
            reportedCost: {
              micros: "2500000",
              currency: "USD",
              basis: "client_attested",
            },
          }),
        }),
      ),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: null })),
    });
    const cost = within(screen.getByTestId("run-stat-cost"));
    expect(cost.getByText("$2.50")).toBeTruthy();
    expect(cost.getByText("agent reported, provisional")).toBeTruthy();
    // Nothing records what the unproductive steps cost.
    expect(
      within(screen.getByTestId("run-stat-wasted")).getByText("not recorded"),
    ).toBeTruthy();
  });

  it("says the cost's basis was not recorded rather than naming one (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            cost: { micros: "4131265", currency: "USD", basis: null },
          }),
        }),
      ),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: null })),
    });
    expect(
      within(screen.getByTestId("run-stat-cost")).getByText(
        "basis not recorded",
      ),
    ).toBeTruthy();
  });

  it("claims no wasted figure, and no warning hue, even when the rollup counted every step productive (negative)", async () => {
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: { ...rollup, productiveRatio: 1 } })),
    });
    const wasted = screen.getByTestId("run-stat-wasted");
    expect(within(wasted).getByText("not recorded")).toBeTruthy();
    expect(within(wasted).queryByText("$0.00")).toBeNull();
    expect(wasted.innerHTML).not.toContain("text-critical");
  });

  it("shows the cache's recorded saving and never reads the price book, and says not recorded for a row without one (negative)", async () => {
    const { calls } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      priceBook: ok(todaysBook()),
    });
    // The rollup recorded a $1.228797 saving for the run's 91,022 cache reads.
    expect(screen.getByTestId("run-stat-cache")).toHaveTextContent(
      "83%saved about $1.23",
    );
    expect(calls.priceBook).toHaveLength(0);
    cleanup();
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      // A row rolled up before the rollup recorded savings.
      cost: ok(
        runCost({
          rollup: {
            ...rollup,
            byModel: rollup.byModel.map((row) => ({
              ...row,
              cacheSaving: null,
            })),
          },
        }),
      ),
    });
    const stat = screen.getByTestId("run-stat-cache");
    expect(stat).toHaveTextContent(/^Cache hit83%saving not recorded$/);
    expect(stat).not.toHaveTextContent("$");
  });

  it("keeps the token classes at their recorded cost after a rate change, reading no price book", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        cost: ok(runCost()),
        // Today's book prices every class at $150 a million.
        priceBook: ok(todaysBook()),
      },
      { tab: "cost" },
    );
    expect(calls.priceBook).toHaveLength(0);
    const cost = (tokenClass: string) =>
      screen
        .getAllByTestId("token-class-row")
        .find((row) => row.dataset.class === tokenClass)?.children[2]
        ?.textContent;
    // The split the rollup recorded when the calls were made. At today's rate
    // the 12,004 output tokens would be $1.8006, not the recorded $2.034842.
    expect(cost("input_uncached")).toBe("$1.09224");
    expect(cost("cache_read")).toBe("$0.136533");
    expect(cost("cache_write_5m")).toBe("$0.30765");
    expect(cost("output")).toBe("$2.034842");
    expect(cost("reasoning")).toBe("$0.56");
    expect(screen.getByTestId("token-class-total")).toHaveTextContent(
      "$4.131265",
    );
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
    // No read carries the base branch or a release, so each row the design
    // draws says so rather than naming one.
    const rows = changes
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["Base", "not recorded"],
        ["Release", "not recorded"],
      ]),
    );
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

  it("heads Changes with the pull request's state when no check was read, and names a pull request it cannot link as text (negative)", async () => {
    const [pull] = runWork().pullRequests;
    if (pull === undefined) throw new Error("the builder holds a pull request");
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(
        runWork({
          pullRequests: [
            {
              ...pull,
              state: "merged",
              url: "https://gitlab.com/acme/platform/-/merge_requests/482",
              ci: null,
            },
          ],
        }),
      ),
    });
    const panel = await screen.findByTestId("run-changes");
    const changes = within(panel);
    expect(changes.getByText("acme/platform#482")).toBeTruthy();
    expect(
      changes.queryByRole("link", { name: "acme/platform#482" }),
    ).toBeNull();
    // With no check read, the panel's head is the pull request's own state.
    expect(changes.getAllByText("merged")).toHaveLength(2);
    expect(changes.getByText("none reported")).toBeTruthy();
  });

  it("names the pull request read's failure in Changes rather than saying there is none (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: readError("github_unreachable", 502),
    });
    const changes = within(await screen.findByTestId("run-changes"));
    expect(changes.queryByText("none")).toBeNull();
    expect(changes.getByText(/github_unreachable/)).toBeTruthy();
  });

  it("names a running check by its status, marks a partial outputs read's file count as a floor, and folds files past eight into a count", async () => {
    const [pull] = runWork().pullRequests;
    if (pull === undefined || pull.ci === null)
      throw new Error("the builder holds a pull request with checks");
    const [check] = pull.ci.runs;
    if (check === undefined) throw new Error("the builder holds a check");
    const files = Array.from({ length: 10 }, (_, index) =>
      runOutputNode({
        seq: index === 0 ? null : String(100 + index),
        name: `src/release/file-${String(index)}.ts`,
        stat: { added: 1, removed: 0 },
      }),
    );
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(
        runWork({
          pullRequests: [
            {
              ...pull,
              ci: {
                ...pull.ci,
                overall: "pending",
                runs: [{ ...check, status: "in_progress", conclusion: null }],
              },
            },
            { ...pull, number: 483, ci: null },
          ],
        }),
      ),
      outputs: ok(runOutputs(files, { complete: false })),
    });
    const changes = within(await screen.findByTestId("run-changes"));
    expect(changes.getByText("test in_progress")).toBeTruthy();
    expect(changes.getByText("in 10 files+")).toBeTruthy();
    expect(
      within(changes.getByTestId("run-changed-files")).getAllByRole("listitem"),
    ).toHaveLength(9);
    expect(changes.getByText("2 more in the outputs")).toBeTruthy();
  });
});

describe("sealing a run (ADR-169)", () => {
  const actions = () =>
    [...screen.getByTestId("run-actions").querySelectorAll("[data-testid]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => id === "run-seal" || id === "run-export");

  it("offers Seal run on a live wrapped run, before Export, which stays last", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ status: "live", sealedAt: null, endedAt: null }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(actions()).toEqual(["run-seal", "run-export"]);
  });

  it("offers Seal run on a run Oxagen closed for silence, which is not final, and holds Export until a final seal", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ outcome: "unknown", sealSource: "idle_timeout" }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-seal")).toBeEnabled();
    // export_run refuses an idle-closed run, so the page does not offer it.
    const exportButton = screen.getByTestId("run-export");
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAttribute("data-reason", "export-idle");
    expect(exportButton).toHaveAccessibleDescription(
      "Oxagen closed this run for silence, and its next event would reopen it. A signed bundle waits for a final seal: the host's own, or Seal run.",
    );
  });

  it("offers Export on a run a person sealed, which is final (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ outcome: "unknown", sealSource: "operator" }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-export")).toBeEnabled();
  });

  it("offers no seal on a run its host sealed, or on a ledger run (negative)", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ sealSource: "agent_stop" }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-seal")).toBeNull();
    cleanup();
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            id: "arun_7k2m9q",
            source: "ledger",
            status: "live",
            sealedAt: null,
            endedAt: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-seal")).toBeNull();
  });

  it("says a person sealed the run, and offers no second seal", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ outcome: "unknown", sealSource: "operator" }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-sealed-operator")).toHaveTextContent(
      "sealed by an operator",
    );
    expect(screen.queryByTestId("run-ended")).toBeNull();
    expect(screen.queryByTestId("run-seal")).toBeNull();
  });
});

describe("an open run's cost and the idle close (#3980)", () => {
  const estimate = () => {
    const { rollup } = runCost();
    if (rollup === null) throw new Error("runCost() builds a rollup");
    return runCost({ rollup: { ...rollup, isEstimate: true } });
  };

  it("labels a rollup built from an open run as an estimate", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ sealedAt: null }) })),
      transcript: ok(runTranscript()),
      cost: ok(estimate()),
    });
    // The rebuilt page draws the run's cost once, in the stat row, where
    // #3980 labelled it; its note reads "estimate" in place of the basis.
    const cost = within(screen.getByTestId("run-stat-cost"));
    expect(cost.getByText("$4.13")).toBeTruthy();
    expect(cost.getByText("estimate")).toBeTruthy();
    expect(cost.queryByText("gateway_observed")).toBeNull();
    expect(screen.queryByText(/Finalized rollup/)).toBeNull();
  });

  it("marks Spend by area's cost an estimate while the run is open", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({ run: runRow({ sealedAt: null, costIsEstimate: true }) }),
        ),
        transcript: ok(runTranscript()),
        cost: ok(estimate()),
      },
      { tab: "cost" },
    );
    expect(screen.getByTestId("run-spend-estimate")).toHaveTextContent(
      "estimate",
    );
    expect(screen.getByTestId("spend-by-area")).toHaveTextContent("$4.13");
  });

  it("marks the cost an estimate for a sealed run whose row predates the seal, until a rollup says otherwise", async () => {
    // #3980 drew this on the header's Usage strip, which the rebuilt header
    // does not carry; the stat row reads the same rule.
    await renderRun({
      detail: ok(runDetail({ run: runRow({ costIsEstimate: true }) })),
      transcript: ok(runTranscript()),
      cost: ok(runCost({ rollup: null })),
    });
    expect(
      within(screen.getByTestId("run-stat-cost")).getByText("estimate"),
    ).toBeTruthy();
  });

  it("says above the Cost tab's figures that they are an estimate", async () => {
    await renderRun(
      {
        detail: ok(runDetail({ run: runRow({ sealedAt: null }) })),
        transcript: ok(runTranscript()),
        cost: ok(estimate()),
      },
      { tab: "cost" },
    );
    expect(screen.getByTestId("cost-estimate")).toHaveTextContent(
      "They are final once the run seals.",
    );
  });

  it("says nothing of an estimate once the rollup priced the sealed run (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        cost: ok(runCost()),
      },
      { tab: "cost" },
    );
    expect(screen.queryByTestId("cost-estimate")).toBeNull();
    expect(screen.queryByTestId("run-spend-estimate")).toBeNull();
  });

  it("names a run Oxagen closed for silence, with no end it can claim", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            outcome: "unknown",
            sealSource: "idle_timeout",
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-closed-idle")).toHaveTextContent(
      "no event for 12 hours",
    );
    const stats = within(screen.getByTestId("run-stats"));
    expect(stats.getByText("no end recorded")).toBeTruthy();
    expect(
      within(screen.getByTestId("run-stat-wall")).getByText("not recorded"),
    ).toBeTruthy();
  });

  it("gives the Cost tab's wall clock no end for a run Oxagen closed for silence, as the stat row does", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            run: runRow({ outcome: "unknown", sealSource: "idle_timeout" }),
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "cost" },
    );
    expect(
      within(screen.getByTestId("inst-wall")).getByText("not recorded"),
    ).toBeTruthy();
  });

  it("calls an open run's figures an estimate on the Cost tab and the stat row alike, even when its row reads final", async () => {
    // A row the idle close sealed reads final until the next frame rebuilds
    // it open; the run's own open state decides, once, in metrics.ts.
    await renderRun(
      {
        detail: ok(
          runDetail({ run: runRow({ status: "live", sealedAt: null }) }),
        ),
        transcript: ok(runTranscript()),
        cost: ok(runCost()),
      },
      { tab: "cost" },
    );
    expect(screen.getByTestId("cost-estimate")).toBeTruthy();
    expect(
      within(screen.getByTestId("run-stat-cost")).getByText("estimate"),
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
    const row = issues.getByTestId("run-issue");
    expect(row).toHaveTextContent("ENG-4121");
    // The relation is the one the record carries: the task the run was
    // started for, on the edge the run's own reference states.
    expect(within(row).getByText("task")).toBeTruthy();
    expect(within(row).getByText("stated")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("says a run with no task reference names no issue, and counts a floor while GitHub's closing list is unread (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail({ run: runRow({ taskRef: null }) })),
        transcript: ok(runTranscript()),
      },
      { tab: "issues" },
    );
    // No pull request was recorded, so the answer is exact.
    expect(
      screen.getByText(
        "This run names no issue, and no pull request it opened closes one.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("run-tab-count-issues")).toHaveTextContent(/^0$/);
    cleanup();
    await renderRun(
      {
        detail: ok(runDetail({ run: runRow({ taskRef: null }) })),
        transcript: ok(runTranscript()),
        work: ok(runWork()),
      },
      { tab: "issues" },
    );
    // A recorded pull request whose closing list GitHub did not return.
    expect(
      screen.getByText(
        "This run names no issue. GitHub did not return the issues its pull requests close.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("run-tab-count-issues")).toHaveTextContent("0+");
  });

  it("counts the issues the run's pull requests close in the tab, the same rows the table draws", async () => {
    const work = runWork();
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        work: ok({
          ...work,
          pullRequests: work.pullRequests.map((pr) => ({
            ...pr,
            closingIssues: {
              issues: [
                {
                  owner: "acme",
                  repo: "platform",
                  number: 490,
                  title: "Release checklist",
                  url: "https://github.com/acme/platform/issues/490",
                  state: "open" as const,
                },
              ],
              complete: true,
            },
          })),
        }),
      },
      { tab: "issues" },
    );
    const rows = screen.getAllByTestId("run-issue");
    expect(screen.getByTestId("run-tab-count-issues")).toHaveTextContent(
      String(rows.length),
    );
    expect(rows).toHaveLength(2);
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
    // The tab lists from the page's one whole-run read and makes none of
    // its own, so its rows and the tab's count cannot disagree.
    expect(calls.transcript).toEqual([
      [ctx, "tse_7k2m9q", "everything", { kinds: [] }],
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

  it("counts on the Policy tab only the decisions its table lists, not the harness's folded checks", async () => {
    const check = transcriptEntry({
      seq: "50",
      endSeq: "51",
      kind: "tool_call",
      label: "Read",
      kinds: ["tools", "policy"],
      decision: {
        seq: "51",
        decision: "allow",
        type: "permission",
        at: "2026-09-20T00:00:00Z",
        source: "harness",
      },
    });
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ entries: [decided, check] })),
      },
      { tab: "policy" },
    );
    expect(
      within(
        screen.getByRole("table", { name: "Policy decisions" }),
      ).getAllByTestId("run-policy-decision"),
    ).toHaveLength(1);
    expect(screen.getByTestId("harness-checks")).toBeTruthy();
    expect(screen.getByTestId("run-tab-count-policy")).toHaveTextContent(/^1$/);
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
      screen.getByRole("region", { name: "Context frames" }),
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

describe("what the session recorded", () => {
  it("reads effort, thinking and permission mode from the session row into the rig", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            effort: "medium",
            thinking: true,
            permissionMode: "acceptEdits",
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-effort")).toHaveTextContent("effort medium");
    // A recorded value carries no "why it is missing" reading.
    expect(screen.getByTestId("run-effort")).not.toHaveAttribute("title");
    expect(screen.getByTestId("run-thinking")).toHaveTextContent("thinking on");
    expect(screen.getByTestId("run-permission-mode")).toHaveTextContent(
      "mode acceptEdits",
    );
  });

  it("says effort was not captured, and draws no thinking or mode chip, when the session recorded none (negative)", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-effort")).toHaveTextContent(
      "effort not captured",
    );
    expect(screen.queryByTestId("run-thinking")).toBeNull();
    expect(screen.queryByTestId("run-permission-mode")).toBeNull();
  });

  it("ends the when line and the wall clock at the recorder's end time, not the seal's receipt", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            status: "sealed",
            startedAt: "2026-09-15T08:00:00.000Z",
            endedAt: "2026-09-15T08:01:30.000Z",
            sealedAt: "2026-09-15T08:10:00.000Z",
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-ended")).toHaveTextContent("ended");
    expect(screen.getByTestId("run-when")).not.toHaveTextContent("sealed");
    expect(screen.getByTestId("run-stat-wall")).toHaveTextContent("1:30");
  });

  it("reads a halted run with no seal instant as ended with no seal recorded, never as live (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ status: "halted", sealedAt: null, endedAt: null }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-when")).toHaveTextContent(
      "ended with no seal recorded",
    );
  });

  it("notes why the last automatic summary failed beside the summary", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ enrichmentError: "model_timeout" }) }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-summary-failed")).toHaveTextContent(
      "The last automatic summary failed (model_timeout).",
    );
  });

  it("labels the operator as the host's enroller when the record says the name came from there", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ operatorAttribution: "host_enroller" }) }),
      ),
      transcript: ok(runTranscript()),
    });
    const operator = within(screen.getByTestId("run-operator"));
    expect(operator.getByText("enrolled the host")).toBeTruthy();
    expect(operator.queryByText("operator")).toBeNull();
  });

  it("lists the subagents the session started under the checkout, and draws no row when it started none", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(
        runWork({
          subagents: [
            {
              agentRef: "a1b2c3d4e5f6",
              type: "Explore",
              firstSeq: "3",
              lastSeq: "9",
              stopped: true,
            },
            {
              agentRef: "f6e5d4c3b2a1",
              type: null,
              firstSeq: "10",
              lastSeq: "12",
              stopped: false,
            },
          ],
        }),
      ),
    });
    const row = within(await screen.findByTestId("run-subagents"));
    expect(row.getByText("Explore")).toBeTruthy();
    expect(row.getByText("a1b2c3d")).toBeTruthy();
    expect(row.getByText("type not recorded")).toBeTruthy();
    // A sealed run's subagent with no stop frame is not "running".
    expect(row.getByText("no stop recorded")).toBeTruthy();
    cleanup();
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(runWork({ subagents: [] })),
    });
    await screen.findByTestId("run-checkout");
    expect(screen.queryByTestId("run-subagents")).toBeNull();
  });

  it("prints the checkout the session touched last, not the first one recorded", async () => {
    const base = runWork();
    const [checkout] = base.checkouts;
    if (checkout === undefined) throw new Error("the builder holds a checkout");
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
      work: ok(
        runWork({
          checkouts: [
            { ...checkout, ref: "co_old", path: "~/src/old", lastSeq: "999" },
            { ...checkout, ref: "co_new", path: "~/src/new", lastSeq: "1000" },
          ],
        }),
      ),
    });
    expect(await screen.findByTestId("run-checkout-path")).toHaveTextContent(
      "mac-studio.local:~/src/new",
    );
  });

  it("counts the session's reported tokens, labelled provisional, before the rollup rebuilds the run", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            reportedTokens: {
              input: 100,
              output: 50,
              cacheRead: 1000,
              cacheWrite: 10,
            },
          }),
        }),
      ),
      transcript: ok(runTranscript()),
      cost: ok({ rollup: null }),
    });
    const tokens = screen.getByTestId("run-stat-tokens");
    expect(tokens).toHaveTextContent("1,160");
    expect(tokens).toHaveTextContent(
      "reported by the session, provisional until the rollup",
    );
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

  it("leaves main#main to the page, and draws four blocks and seven rows with no figure (negative)", () => {
    render(
      <IntlProvider>
        <RunLoading />
      </IntlProvider>,
    );
    // While the page streams in, this fallback and the hidden page share the
    // document, so a second main#main here would give the skip link two
    // targets (#4036). The frame is a plain container with the page's classes.
    expect(document.getElementById("main")).toBeNull();
    expect(document.querySelector("main")).toBeNull();
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
