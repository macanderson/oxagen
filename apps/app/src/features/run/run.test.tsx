// @vitest-environment jsdom
// The Run page over a fake DataSource: the header, the tab chooser, and each
// of the four sections in its ok, empty, denied and error states, with an axe
// check on every render.
//
// Two rules the tests hold the page to, because breaking either is how a
// console starts lying: only the chosen tab makes its read, and a value the
// contract did not carry reads "not recorded" rather than a zero.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  NOW,
  runCost,
  runDetail,
  runFrame,
  runFrameBody,
  runRow,
  mockupTranscript,
  runSource,
  runTranscript,
  runProof,
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
  it("leads with the generated name, keeps the id under it, and labels the model's sentence", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("Cut the 3.2 release branch");
    expect(screen.getByText("tse_7k2m9q")).toBeTruthy();
    const summary = screen.getByTestId("generated-summary");
    expect(summary).toHaveTextContent("Cut release/3.2 from main");
    expect(summary).toHaveTextContent("generated");
    expect(summary).toHaveTextContent("Written by z-ai/glm-flash-latest on");
    await expectNoAxe(container);
  });

  it("heads a run with its task reference when no generated name exists", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ name: null, summary: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
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
    });
    expect(screen.getAllByText("not recorded").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("names the operator, the model and the machine the run ran on", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const facts = within(screen.getByTestId("run-facts"));
    expect(facts.getByText("Marcus Bell")).toBeTruthy();
    expect(facts.getByText("prn_marcusbell")).toBeTruthy();
    expect(facts.getByText("claude-sonnet-5")).toBeTruthy();
    expect(facts.getByText("anthropic \u00b7 sonnet")).toBeTruthy();
    expect(facts.getByText("mac-studio.local")).toBeTruthy();
    expect(
      facts.getByText("darwin 15.6 \u00b7 arm64 \u00b7 v24.4.0"),
    ).toBeTruthy();
    await expectNoAxe(container);
  });

  it("reads a model and a machine the run does not carry as not recorded, never a placeholder", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({ source: "ledger", model: null, machine: null }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    const facts = within(screen.getByTestId("run-facts"));
    expect(facts.getAllByText("not recorded")).toHaveLength(2);
    expect(
      facts.getByText("The evidence ledger records no host for a run."),
    ).toBeTruthy();
    expect(facts.queryByText("unknown")).toBeNull();
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
    const facts = within(screen.getByTestId("run-facts"));
    expect(facts.getByText("An agent, not a person")).toBeTruthy();
    expect(facts.queryByText("Marcus Bell")).toBeNull();
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
      within(screen.getByTestId("run-facts")).getByText(
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
    const facts = within(screen.getByTestId("run-facts"));
    expect(facts.queryByText("A person, name not recorded")).toBeNull();
    expect(facts.getByText("not recorded")).toBeTruthy();
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

  it("disables every control on a live ledger run and says why (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", source: "ledger" }) }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-pause")).toBeDisabled();
    expect(screen.getByTestId("ledger-no-control")).toHaveTextContent(
      "Oxagen holds no run token it can revoke",
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

describe("tabs", () => {
  it("opens Transcript by default and reads only that tab", async () => {
    const { calls } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(calls.transcript).toHaveLength(1);
    expect(calls.cost).toHaveLength(0);
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

  it("opens Transcript for a tab that is not a section, Policy included (negative)", async () => {
    for (const tab of ["unknown", "policy"]) {
      cleanup();
      const { calls } = await renderRun(
        { detail: ok(runDetail()), transcript: ok(runTranscript()) },
        { tab },
      );
      expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
      expect(calls.approvals).toHaveLength(0);
    }
    const tabs = screen.getByRole("navigation", { name: "Run sections" });
    expect(within(tabs).queryByRole("link", { name: "Policy" })).toBeNull();
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
    expect(turns[1]).toContainElement(screen.getByTestId("transcript-you"));
    expect(screen.getByTestId("transcript-you")).toHaveTextContent(
      "Cut the 2026.9.2 release candidate.",
    );
    expect(turns[1]).toContainElement(screen.getByTestId("transcript-agent"));
    expect(screen.getByTestId("transcript-agent")).toHaveTextContent(
      "Both failures predate the release scope.",
    );
    const nodes = screen
      .getAllByTestId("transcript-step")
      .map((step) => step.getAttribute("data-node"));
    expect(nodes).toEqual([
      "control",
      "tool",
      "control",
      "model",
      "tool",
      "control",
      "control",
      "model",
      "deny",
    ]);
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
    expect(screen.getAllByTestId("transcript-frame")).toHaveLength(13);
    expect(screen.getByText('{"open":34}')).toBeTruthy();
    expect(screen.getByText(/kept a digest and no body/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Frame 7 on the Frames tab" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&body=7",
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
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&body=37",
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
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&frames=ZjoyMA",
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
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames",
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
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&frames=ZjoxMA&body=11",
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
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&frames=ZjoxMA",
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
    expect(calls.transcript[0]).toEqual([
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
    expect(calls.transcript[0]?.[3]).toEqual({ kinds: ["tools"] });
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

describe("operator sections", () => {
  it("opens the transcript for a retired chain tab without reading proof data", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "chain" },
    );
    expect(calls.chain).toHaveLength(0);
    expect(calls.transcript).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Chain and seal" })).toBeNull();
  });
});

describe("approvals on the run", () => {
  it("reads list_approvals and list_resolved_approvals narrowed to this run, and only when its tab is open", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        approvals: ok({ items: [], more: false }),
        resolvedApprovals: ok([]),
      },
      { tab: "approvals" },
    );
    expect(calls.approvals).toEqual([[ctx, { runId: "tse_7k2m9q" }]]);
    expect(calls.resolvedApprovals).toEqual([[ctx, { runId: "tse_7k2m9q" }]]);
    expect(calls.transcript).toHaveLength(0);
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
    expect(calls.transcript.map((call) => call[2])).toEqual(["turns", "steps"]);
    expect(screen.getAllByTestId("waterfall-bar")).toHaveLength(1);
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

describe("proof tab routing", () => {
  it("reads proof only for the selected proof tab", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), proof: ok(runProof()) },
      { tab: "proof" },
    );
    expect(screen.getByTestId("run-proof")).toBeInTheDocument();
    expect(calls.proof).toEqual([[ctx, "tse_7k2m9q"]]);
    expect(calls.transcript).toHaveLength(0);
  });
});
