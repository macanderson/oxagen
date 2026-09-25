// @vitest-environment jsdom
// The Governed actions tab over a fake DataSource, called the way the Run
// page calls it: the Timeline, the frame player bar, the open frame with its
// body read on demand, the frame list, and the calls parked on the run with
// their Approve and Deny, each with an axe check where it renders a state.
//
// The rules the tests hold the tab to: a value the record did not carry reads
// "not recorded" rather than a zero, a body is read for the open frame alone
// and only when it retained bytes, and no parked call on the run becomes
// unreachable from the page.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalQueue,
  ResolvedApprovalItem,
} from "@/data/contracts/approvals";
import type { MandateList } from "@/data/contracts/mandates";
import type {
  RunFrame,
  RunFrameBody,
  RunTranscript,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  decidedRelease,
  parkedRelease,
  releaseAt,
  releaseFrames,
  releaseTranscript,
} from "./actions-tab.builders";
import {
  NOW,
  runCost,
  runDetail,
  runFrame,
  runFrameBody,
  runOutputs,
  runRow,
  runSource,
  runTranscript,
} from "./run.builders";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh }),
}));
const openApprovals = vi.fn();
vi.mock("@/features/shell/client", () => ({ openApprovals }));
const resolveApprovalAction = vi.fn();
const readApprovalEligibility = vi.fn();
vi.mock("../fleet/actions", () => ({
  resolveApprovalAction,
  readApprovalEligibility,
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { GovernedActionsTab } = await import("./actions-tab");
const { runMetrics } = await import("./metrics");

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

const ok = readOk;
const RUN = "/acme/core-platform/runs/tse_7k2m9q";

type Setup = {
  frames?: RunFrame[];
  cursor?: string | null;
  more?: boolean;
  everything?: Read<RunTranscript>;
  approvals?: Read<ApprovalQueue>;
  resolved?: Read<ResolvedApprovalItem[]>;
  /** The resolved read stopped at its bound with decisions left unread (#3477). */
  resolvedMore?: boolean;
  mandates?: Read<MandateList>;
  frameBody?: Read<RunFrameBody>;
  run?: Partial<RunRow>;
  /** `?frames=` */
  page?: string;
  /** `?body=` */
  body?: string;
};

/** The tab as the Run page calls it: a function over the page's props bundle. */
async function renderTab(setup: Setup = {}) {
  const run = runRow({
    status: "live",
    sealedAt: null,
    frames: 42,
    enforcementTier: "gateway",
    ...setup.run,
  });
  const detail = runDetail({
    run,
    frames: {
      frames: setup.frames ?? releaseFrames(),
      cursor: setup.cursor ?? null,
      more: setup.more ?? false,
    },
  });
  const { source, calls } = runSource({
    detail: ok(detail),
    frameBody: setup.frameBody,
    approvals: setup.approvals,
    resolvedApprovals:
      setup.resolved === undefined || !setup.resolved.ok
        ? setup.resolved
        : ok({
            items: setup.resolved.value,
            more: setup.resolvedMore ?? false,
          }),
    mandates: setup.mandates,
  });
  const everything = setup.everything ?? ok(releaseTranscript());
  const cost = ok(runCost());
  const element = await GovernedActionsTab({
    ctx,
    source,
    run,
    detail,
    place: { org: "acme", ws: "core-platform", runId: run.id },
    view: {
      kinds: [],
      frames: setup.page ?? null,
      body: setup.body ?? null,
    },
    metrics: runMetrics({ run, cost, transcript: everything }),
    everything,
    cost,
    outputs: ok(runOutputs()),
    work: source.runs.work(ctx, run.id),
    agent: null,
    now: NOW,
  });
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
}

const frameLink = (seq: string, page?: string) =>
  `${RUN}?tab=actions${page === undefined ? "" : `&frames=${page}`}&body=${seq}`;

afterEach(() => {
  cleanup();
  push.mockClear();
  openApprovals.mockClear();
  resolveApprovalAction.mockReset();
  readApprovalEligibility.mockReset();
});

describe("timeline", () => {
  it("draws the page's frames against the run's count, by kind, in their turns, with the steer and the parked call marked", async () => {
    const { container } = await renderTab();
    const timeline = screen.getByRole("region", { name: "Timeline" });
    expect(within(timeline).getByTestId("timeline-shown")).toHaveTextContent(
      "16 frames shown · 42 in the run",
    );
    expect(within(timeline).getByTestId("legend-model")).toHaveTextContent(
      "model calls 6",
    );
    expect(within(timeline).getByTestId("legend-gov")).toHaveTextContent(
      "governance 4",
    );
    expect(within(timeline).getByTestId("legend-life")).toHaveTextContent(
      "lifecycle 1",
    );
    expect(
      within(timeline)
        .getAllByTestId("timeline-turn")
        .map((turn) => turn.textContent),
    ).toEqual(["turn 1", "turn 2 after steer"]);
    expect(within(timeline).getByTestId("timeline-turns")).toHaveTextContent(
      "2 turns in view",
    );
    expect(
      within(timeline).getByTestId("timeline-mark-steer"),
    ).toHaveTextContent("steer");
    expect(
      within(timeline).getByTestId("timeline-mark-parked"),
    ).toHaveTextContent("parked · approval");
    expect(within(timeline).getByTestId("timeline-axis")).toHaveTextContent(
      "09:14:02+49 s · 09:14:51 · live",
    );
    await expectNoAxe(container);
  });

  it("links every tick to its frame and marks the open one", async () => {
    await renderTab({ body: "5", frameBody: ok(runFrameBody({ seq: "5" })) });
    const ticks = screen.getAllByTestId("timeline-tick");
    expect(ticks).toHaveLength(16);
    expect(ticks[10]).toHaveAttribute("href", frameLink("10"));
    expect(ticks[10]).toHaveAttribute("data-kind", "op");
    expect(ticks[10]).toHaveAccessibleName("Frame 10 control.steer");
    expect(ticks[5]).toHaveAttribute("aria-current", "true");
    expect(ticks[4]).not.toHaveAttribute("aria-current");
  });

  it("draws no turn band the transcript did not carry, and ends the axis without 'live' on a sealed run (negative)", async () => {
    await renderTab({
      everything: readError("frame_store_unreachable", 502),
      run: { status: "sealed", sealedAt: new Date(NOW).toISOString() },
    });
    expect(screen.queryAllByTestId("timeline-turn")).toHaveLength(0);
    expect(screen.queryByTestId("timeline-turns")).toBeNull();
    // Without the transcript's decision the policy frame that asked is not
    // marked as parked; the request itself still is.
    expect(screen.getAllByTestId("timeline-mark-parked")).toHaveLength(1);
    expect(screen.getByTestId("timeline-axis")).not.toHaveTextContent("live");
    expect(screen.getByTestId("frame-list-state")).toHaveTextContent("sealed");
  });
});

describe("the open frame", () => {
  it("opens the first frame shown when the URL names none, and reads no body for a frame that kept its digest alone", async () => {
    const { calls, container } = await renderTab();
    const open = screen.getByTestId("frame-open");
    expect(open).toHaveAttribute("data-seq", "0");
    expect(
      screen.getByRole("heading", { name: "Frame 0 agent_start" }),
    ).toBeTruthy();
    expect(calls.frameBody).toHaveLength(0);
    expect(screen.getByTestId("frame-body")).toHaveTextContent(
      "kept this frame's digest and no bytes",
    );
    expect(within(open).getByText("digest only")).toBeTruthy();
    expect(screen.getByTestId("frame-previous")).toBeDisabled();
    expect(screen.getByTestId("frame-next")).toHaveAttribute(
      "href",
      frameLink("1"),
    );
    expect(screen.getByTestId("frame-position")).toHaveTextContent(
      "frame 1 of 16 shown · 42 in the run",
    );
    await expectNoAxe(container);
  });

  it("reads no body for the frame open by default, and offers to read it when it retained bytes", async () => {
    const { calls } = await renderTab({
      frames: [runFrame(), runFrame({ seq: "12", cursor: "ZjoxMg" })],
      page: "ZjoxMA",
    });
    expect(calls.frameBody).toHaveLength(0);
    expect(screen.queryByTestId("frame-body")).toBeNull();
    expect(screen.getByTestId("frame-open-body")).toHaveAttribute(
      "href",
      frameLink("11", "ZjoxMA"),
    );
    expect(screen.getByTestId("frame-open")).toHaveTextContent(
      "Bodybytes retained",
    );
  });

  it("opens ?body=<seq>, reads that frame's body and draws it as text, with its neighbours a step away", async () => {
    const { calls, container } = await renderTab({
      body: "3",
      frameBody: ok(runFrameBody({ seq: "3", digest: "sha256:bd3" })),
    });
    expect(calls.frameBody).toEqual([[ctx, "tse_7k2m9q", "3"]]);
    const body = screen.getByTestId("frame-body");
    expect(body).toHaveTextContent("application/json");
    expect(body).toHaveTextContent("92 bytes");
    expect(body).toHaveTextContent("Cut release/3.2 from main.");
    expect(screen.getByTestId("frame-previous")).toHaveAttribute(
      "href",
      frameLink("2"),
    );
    expect(screen.getByTestId("frame-next")).toHaveAttribute(
      "href",
      frameLink("4"),
    );
    expect(screen.getByTestId("frame-position")).toHaveTextContent(
      "frame 4 of 16 shown · 42 in the run",
    );
    const rows = screen.getAllByTestId("frame-row");
    expect(rows[3]).toHaveAttribute("aria-current", "true");
    expect(rows[3]).toHaveTextContent("model.response");
    await expectNoAxe(container);
  });

  it("states the frame's cost with its basis, its turn, and the decision the transcript recorded", async () => {
    await renderTab({
      body: "3",
      frameBody: ok(runFrameBody({ seq: "3" })),
    });
    expect(screen.getByTestId("frame-cost")).toHaveTextContent(
      "$0.4126 client_attested",
    );
    expect(screen.getByTestId("frame-open")).toHaveTextContent("turn 1");
    cleanup();
    await renderTab({
      body: "5",
      frameBody: ok(runFrameBody({ seq: "5" })),
    });
    const open = screen.getByTestId("frame-open");
    expect(within(open).getByText("allow")).toBeTruthy();
    expect(open).toHaveTextContent("Costnot recorded");
    expect(open).toHaveTextContent("Turnturn 1");
  });

  it("says a frame before the first turn is, and a frame the transcript did not carry has no turn (negative)", async () => {
    await renderTab({ body: "1", frameBody: ok(runFrameBody({ seq: "1" })) });
    expect(screen.getByTestId("frame-open")).toHaveTextContent(
      "before the first turn",
    );
    cleanup();
    await renderTab({
      body: "1",
      frameBody: ok(runFrameBody({ seq: "1" })),
      everything: readError("frame_store_unreachable", 502),
    });
    expect(screen.getByTestId("frame-open")).toHaveTextContent(
      "Turnnot recorded",
    );
  });

  it("keeps the frames cursor in every link it draws", async () => {
    await renderTab({
      page: "ZjoxMA",
      body: "3",
      frameBody: ok(runFrameBody({ seq: "3" })),
    });
    expect(screen.getByTestId("frame-next")).toHaveAttribute(
      "href",
      frameLink("4", "ZjoxMA"),
    );
    expect(screen.getAllByTestId("timeline-tick")[0]).toHaveAttribute(
      "href",
      frameLink("0", "ZjoxMA"),
    );
    expect(screen.getByTestId("player-first")).toHaveAttribute(
      "href",
      frameLink("0", "ZjoxMA"),
    );
  });

  it("reads no body for a value that is not a frame seq (negative)", async () => {
    const { calls } = await renderTab({ body: "../etc" });
    expect(calls.frameBody).toHaveLength(0);
    expect(screen.getByTestId("frame-open")).toHaveAttribute("data-seq", "0");
  });

  it("opens a frame the page does not hold, reads its body, and steps to the nearest shown frames", async () => {
    const { calls } = await renderTab({
      frames: ["8", "9", "10", "100"].map((seq) =>
        runFrame({ seq, cursor: seq }),
      ),
      body: "37",
      frameBody: ok(runFrameBody({ seq: "37" })),
    });
    expect(calls.frameBody).toEqual([[ctx, "tse_7k2m9q", "37"]]);
    expect(screen.getByTestId("frame-off-page")).toHaveTextContent(
      "does not hold frame 37",
    );
    expect(screen.getByTestId("frame-previous")).toHaveAttribute(
      "href",
      frameLink("10"),
    );
    expect(screen.getByTestId("frame-next")).toHaveAttribute(
      "href",
      frameLink("100"),
    );
    expect(screen.getByTestId("player-position")).toHaveTextContent(
      "seq 37 · outside the 4 frames shown",
    );
    expect(
      screen
        .getAllByTestId("frame-row")
        .map((row) => row.getAttribute("aria-current")),
    ).toEqual([null, null, null, null]);
  });

  it("names the body read's own failure and keeps the frame list beside it (negative)", async () => {
    await renderTab({ body: "3", frameBody: readError("not_found", 404) });
    expect(screen.getByTestId("frame-open")).toHaveTextContent("not_found");
    expect(screen.getAllByTestId("frame-row")).toHaveLength(16);
  });

  it("says retained bytes that are not text are not shown, keeps their size, and lists each redaction by reason", async () => {
    await renderTab({
      body: "3",
      frameBody: ok(
        runFrameBody({
          seq: "3",
          contentType: "image/png",
          text: null,
          bytes: 4096,
          redactions: [
            {
              path: "bytes:12-60",
              reason: "api key",
              originalDigest: "sha256:cut",
            },
          ],
        }),
      ),
    });
    const body = screen.getByTestId("frame-body");
    expect(body).toHaveTextContent("not UTF-8 text");
    expect(body).toHaveTextContent("4,096 bytes");
    expect(screen.getByTestId("frame-redactions")).toHaveTextContent(
      "removed bytes:12-60: api key",
    );
  });

  it("says a frame that carried no content has none, and reads nothing for it", async () => {
    const { calls } = await renderTab({ body: "6" });
    expect(calls.frameBody).toHaveLength(0);
    expect(screen.getByTestId("frame-open")).toHaveTextContent(
      "Bodyno content",
    );
    expect(screen.queryByTestId("frame-body")).toBeNull();
  });
});

describe("the player bar", () => {
  it("steps by links, and states the run's running total at the frame against its cost, with the basis", async () => {
    const { container } = await renderTab({
      body: "9",
      frameBody: ok(runFrameBody({ seq: "9" })),
    });
    const bar = screen.getByRole("group", { name: "Frame player" });
    expect(within(bar).getByTestId("player-first")).toHaveAttribute(
      "href",
      frameLink("0"),
    );
    expect(within(bar).getByTestId("player-previous")).toHaveAttribute(
      "href",
      frameLink("8"),
    );
    expect(within(bar).getByTestId("player-next")).toHaveAttribute(
      "href",
      frameLink("10"),
    );
    expect(within(bar).getByTestId("player-last")).toHaveAttribute(
      "href",
      frameLink("15"),
    );
    expect(within(bar).getByTestId("player-position")).toHaveTextContent(
      "10 / 16 · seq 9 · 09:14:18.664",
    );
    // 0.4126 + 0 + 0.5518, from the transcript's running total at seq 9.
    expect(within(bar).getByTestId("player-spent")).toHaveTextContent(
      "$0.96 of $4.13 by here · client_attested",
    );
    await expectNoAxe(container);
  });

  it("says the running total is not recorded where the transcript has none, never a zero (negative)", async () => {
    await renderTab({ body: "1", frameBody: ok(runFrameBody({ seq: "1" })) });
    expect(screen.getByTestId("player-spent")).toHaveTextContent(
      "spend by here not recorded",
    );
  });

  it("disables the steps that lead nowhere rather than drawing live links", async () => {
    await renderTab({ body: "15", frameBody: ok(runFrameBody({ seq: "15" })) });
    expect(screen.getByTestId("player-next")).toBeDisabled();
    expect(screen.getByTestId("player-last")).toHaveAttribute(
      "href",
      frameLink("15"),
    );
  });

  it("steps with the arrow keys, and scrubs to the frame the range is released on", async () => {
    const user = userEvent.setup();
    await renderTab({ body: "3", frameBody: ok(runFrameBody({ seq: "3" })) });
    await user.keyboard("{ArrowRight}");
    expect(push).toHaveBeenLastCalledWith(frameLink("4"));
    await user.keyboard("{ArrowLeft}");
    expect(push).toHaveBeenLastCalledWith(frameLink("2"));
    await user.keyboard("{Home}");
    expect(push).toHaveBeenLastCalledWith(frameLink("0"));
    await user.keyboard("{End}");
    expect(push).toHaveBeenLastCalledWith(frameLink("15"));
    push.mockClear();
    // A shortcut, or a key meant for a field, is not a step.
    await user.keyboard("{Control>}{ArrowRight}{/Control}");
    screen.getByRole("slider", { name: "Frame" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(push).not.toHaveBeenCalled();
    // Dragging moves the range without a read; releasing it opens the frame.
    const range = screen.getByRole("slider", { name: "Frame" });
    fireEvent.change(range, { target: { value: "6" } });
    fireEvent.change(range, { target: { value: "7" } });
    expect(push).not.toHaveBeenCalled();
    expect(range).toHaveAttribute("aria-valuetext", "frame 8 of 16");
    fireEvent.pointerUp(range);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenLastCalledWith(frameLink("7"));
  });
});

describe("the frame list", () => {
  it("lists every frame with its seq, type and recorded cost, and names the run's state", async () => {
    await renderTab({ run: { ingressPaused: true } });
    const rows = screen.getAllByTestId("frame-row");
    expect(rows).toHaveLength(16);
    expect(rows[3]).toHaveTextContent("3model.response$0.4126");
    expect(rows[3]).toHaveAttribute("href", frameLink("3"));
    // A frame that recorded no cost carries no chip, never a $0.
    expect(rows[2]).toHaveTextContent(/^2model\.request$/);
    expect(screen.getByTestId("frame-list-state")).toHaveTextContent("paused");
  });

  it("links to the next page only when the page came back full, and keeps the way back to the first", async () => {
    await renderTab({ cursor: "ZjoyMA", more: true });
    expect(screen.getByRole("link", { name: "Later frames" })).toHaveAttribute(
      "href",
      `${RUN}?tab=actions&frames=ZjoyMA`,
    );
    expect(screen.queryByRole("link", { name: "First frames" })).toBeNull();
    cleanup();
    await renderTab({ cursor: "ZjoyMA", more: false, page: "ZjoxMA" });
    expect(screen.queryByRole("link", { name: "Later frames" })).toBeNull();
    expect(screen.getByRole("link", { name: "First frames" })).toHaveAttribute(
      "href",
      `${RUN}?tab=actions`,
    );
  });

  it("says a later page that came back empty holds nothing, and keeps the way back (negative)", async () => {
    const { container } = await renderTab({ frames: [], page: "ZjoyMA" });
    expect(screen.getByTestId("frames-empty")).toHaveTextContent(
      "Nothing lies past the frame this page starts from.",
    );
    expect(screen.getByRole("link", { name: "First frames" })).toHaveAttribute(
      "href",
      `${RUN}?tab=actions`,
    );
    expect(screen.queryByTestId("run-timeline")).toBeNull();
    await expectNoAxe(container);
  });
});

describe("parked calls", () => {
  const pending = (items = [parkedRelease()]) => ok({ items, more: false });

  // The proof capability-ui-map.json names for `resolve_approval` and
  // `get_auto_eligibility` on the Run page: the parked call's card, inside the
  // frame that records it, decides it with Approve and Deny.
  it("draws the parked call's card inside the frame that records it, and Approve decides it", async () => {
    const user = userEvent.setup();
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { resolvedBy: null, eligibility: null },
    });
    resolveApprovalAction.mockResolvedValue({ ok: true, value: {} });
    const { container } = await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      approvals: pending(),
    });
    const parked = screen.getByTestId("frame-parked");
    expect(
      within(screen.getByTestId("frame-open")).getByTestId("frame-parked"),
    ).toBe(parked);
    expect(parked).toHaveTextContent("Parked.");
    const card = within(parked).getByTestId("approval");
    expect(card).toHaveTextContent("github__create_release");
    expect(screen.queryByTestId("parked-elsewhere")).toBeNull();
    await expectNoAxe(container);
    await user.click(within(card).getByTestId("decide"));
    expect(readApprovalEligibility).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "apr_01k5rs3k7",
      "run",
    );
    await user.click(await screen.findByTestId("approve"));
    expect(resolveApprovalAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        approvalId: "apr_01k5rs3k7",
        decision: "approved",
        note: "",
      },
    );
  });

  it("denies the parked call from the same card with the reason given", async () => {
    const user = userEvent.setup();
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { resolvedBy: null, eligibility: null },
    });
    resolveApprovalAction.mockResolvedValue({ ok: true, value: {} });
    await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      approvals: pending(),
    });
    await user.click(screen.getByTestId("decide"));
    await user.type(await screen.findByRole("textbox"), "Not this cycle");
    await user.click(screen.getByTestId("deny"));
    expect(resolveApprovalAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        approvalId: "apr_01k5rs3k7",
        decision: "denied",
        note: "Not this cycle",
      },
    );
  });

  it("draws the assistant's parked call's card on its receipt, by the approval the receipt names", async () => {
    const user = userEvent.setup();
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { resolvedBy: null, eligibility: null },
    });
    // Two parked calls to one tool. The receipt names the one parked
    // earlier, so pairing by the closest instant would open the wrong card.
    const receipt = runFrame({
      seq: "4",
      cursor: "4",
      type: "tool.engine_call_completed",
      stage: "tool",
      summary: "create_workspace parked apr_ws_early",
      observedAt: releaseAt(4),
    });
    const { container } = await renderTab({
      frames: [
        runFrame({
          seq: "3",
          cursor: "3",
          type: "tool.engine_call_started",
          stage: "tool",
          summary: "create_workspace",
          observedAt: releaseAt(3),
        }),
        receipt,
      ],
      everything: ok(runTranscript({ zoom: "everything", entries: [] })),
      body: "4",
      frameBody: ok(runFrameBody({ seq: "4" })),
      approvals: pending([
        parkedRelease({
          id: "apr_ws_late",
          tool: "create_workspace",
          createdAt: releaseAt(4),
        }),
        parkedRelease({
          id: "apr_ws_early",
          tool: "create_workspace",
          createdAt: releaseAt(1),
        }),
      ]),
    });
    const parked = within(screen.getByTestId("frame-open")).getByTestId(
      "frame-parked",
    );
    expect(parked).toHaveTextContent("Parked.");
    expect(within(parked).getAllByTestId("approval")).toHaveLength(1);
    await expectNoAxe(container);
    await user.click(within(parked).getByTestId("decide"));
    expect(readApprovalEligibility).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "apr_ws_early",
      "run",
    );
    // The other parked call stays reachable.
    expect(screen.getByTestId("parked-elsewhere")).toHaveTextContent(
      "1 more call is parked on this run.",
    );
  });

  it("points to the frame a parked call sits at when another frame is open, and draws no second card", async () => {
    await renderTab({ approvals: pending() });
    const pointer = screen.getByTestId("parked-pointer");
    expect(pointer).toHaveTextContent(
      "github__create_release is parked at frame 15.",
    );
    expect(
      within(pointer).getByRole("link", { name: "Open frame 15" }),
    ).toHaveAttribute("href", frameLink("15"));
    expect(screen.queryByTestId("approval")).toBeNull();
  });

  it("lists a parked call no frame on the page records as its card, so it stays reachable", async () => {
    const { container } = await renderTab({
      approvals: pending([parkedRelease({ tool: "stripe__create_payment" })]),
    });
    const elsewhere = screen.getByTestId("parked-elsewhere");
    expect(within(elsewhere).getByTestId("approval")).toHaveTextContent(
      "stripe__create_payment",
    );
    expect(within(elsewhere).getByTestId("decide")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("sends the other parked calls to the drawer while the open frame's card is on screen", async () => {
    const user = userEvent.setup();
    await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      approvals: pending([
        parkedRelease(),
        parkedRelease({ id: "apr_other", tool: "stripe__create_payment" }),
      ]),
    });
    expect(screen.getAllByTestId("approval")).toHaveLength(1);
    const elsewhere = screen.getByTestId("parked-elsewhere");
    expect(elsewhere).toHaveTextContent("1 more call is parked on this run.");
    await user.click(within(elsewhere).getByTestId("open-approvals"));
    expect(openApprovals).toHaveBeenCalledTimes(1);
  });

  it("reads the mandate ledger only when a parked call names a mandate, and draws its bar", async () => {
    const named = await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      approvals: pending([
        parkedRelease({
          mandateId: "mnd_4f2a9c",
          rule: "mandate:mnd_4f2a9c:human_above:amount",
        }),
      ]),
      mandates: mandateList([mandateRow()]),
    });
    expect(named.calls.mandates).toEqual([[ctx, { agentId: null }]]);
    expect(screen.getByTestId("mandate-bar")).toHaveAttribute(
      "data-measure",
      "amount",
    );
    cleanup();
    const unnamed = await renderTab({ approvals: pending() });
    expect(unnamed.calls.mandates).toEqual([]);
  });

  it("names the pending read's failure where the parked calls would be (negative)", async () => {
    await renderTab({ approvals: readError("frame_store_unreachable", 502) });
    expect(screen.getByTestId("parked-elsewhere")).toHaveTextContent(
      "frame_store_unreachable",
    );
  });

  it("draws nothing for parked calls on a run with none (negative)", async () => {
    const { calls } = await renderTab({ approvals: pending([]) });
    expect(calls.approvals).toEqual([[ctx, { runId: "tse_7k2m9q" }]]);
    expect(screen.queryByTestId("parked-elsewhere")).toBeNull();
    expect(screen.queryByTestId("approval")).toBeNull();
  });
});

describe("decided calls", () => {
  it("shows who decided the call the approval frame records, and when", async () => {
    const { calls, container } = await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      resolved: ok([decidedRelease()]),
    });
    expect(calls.resolvedApprovals).toEqual([[ctx, { runId: "tse_7k2m9q" }]]);
    const decided = within(screen.getByTestId("frame-open")).getByTestId(
      "resolved-approval",
    );
    expect(decided).toHaveTextContent("github__create_releaseapproved");
    expect(within(decided).getByTestId("resolved-approver")).toHaveTextContent(
      /^usr_marcusbell$/,
    );
    expect(decided).toHaveTextContent("Sep 15, 2026, 9:15:38 AM");
    expect(screen.queryByTestId("frame-parked")).toBeNull();
    await expectNoAxe(container);
  });

  it("names the rule that released a call with no person, and the execution it led to", async () => {
    await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      resolved: ok([
        decidedRelease({
          resolvedBy: "policy:small-vendor-payments",
          autoRuleRef: "small-vendor-payments",
          execution: {
            status: "succeeded",
            runId: "arun_resumed",
            reason: null,
          },
        }),
      ]),
    });
    expect(screen.getByTestId("resolved-approver")).toHaveTextContent(
      "rule small-vendor-payments with no person",
    );
    expect(screen.getByTestId("approval-execution")).toHaveTextContent(
      "succeeded",
    );
    expect(screen.getByText("arun_resumed")).toBeTruthy();
  });

  it("says an approval frame the record ties to no decision has none, and lists the run's other decisions", async () => {
    await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      resolved: ok([
        decidedRelease({
          id: "apr_expired",
          tool: "delete_workspace",
          resolution: "expired",
          resolvedBy: null,
        }),
      ]),
    });
    expect(screen.getByTestId("approval-unmatched")).toHaveTextContent(
      "The record ties no approval on this run to this frame.",
    );
    const other = screen.getByTestId("resolved-approval");
    expect(other).toHaveTextContent("delete_workspace");
    expect(within(other).getByTestId("resolved-approver")).toHaveTextContent(
      /^system$/,
    );
  });

  // #3477: the run's decided approvals are read up to 1,000 rows. When the
  // read stops with more left, the list says it is the latest part only, so
  // an unmatched frame does not read as having no decision anywhere.
  it("says the decided list is the latest part when the read stopped at its bound (#3477)", async () => {
    await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      resolved: ok([
        decidedRelease({
          id: "apr_expired",
          tool: "delete_workspace",
          resolution: "expired",
          resolvedBy: null,
        }),
      ]),
      resolvedMore: true,
    });
    expect(screen.getByTestId("approval-unmatched")).toBeTruthy();
    expect(screen.getByTestId("approvals-partial")).toHaveTextContent(
      "This run has more decided approvals than one read carries. These are the latest 1, so an older decision is not listed here.",
    );
  });

  it("says nothing about a partial list when the read reached the end of the run's decisions (negative)", async () => {
    await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      resolved: ok([
        decidedRelease({
          id: "apr_expired",
          tool: "delete_workspace",
          resolution: "expired",
          resolvedBy: null,
        }),
      ]),
    });
    expect(screen.getByTestId("approval-unmatched")).toBeTruthy();
    expect(screen.queryByTestId("approvals-partial")).toBeNull();
  });

  it("names the resolved read's failure inside the approval frame (negative)", async () => {
    await renderTab({
      body: "15",
      frameBody: ok(runFrameBody({ seq: "15" })),
      resolved: readError("frame_store_unreachable", 502),
    });
    expect(screen.getByTestId("frame-open")).toHaveTextContent(
      "frame_store_unreachable",
    );
  });

  it("draws no decision on a frame that is not an approval frame (negative)", async () => {
    await renderTab({
      body: "3",
      frameBody: ok(runFrameBody({ seq: "3" })),
      resolved: ok([decidedRelease()]),
    });
    expect(screen.queryByTestId("resolved-approval")).toBeNull();
    expect(screen.queryByTestId("approval-unmatched")).toBeNull();
  });
});
