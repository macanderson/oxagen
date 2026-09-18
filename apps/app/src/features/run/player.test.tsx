// @vitest-environment jsdom
// The run replay transport (spec §8.4): the playhead, its idle compression,
// the scrub and step controls, live-head following, and pagination through
// `readTranscriptPage`. Mirrors the harness conventions of controls.test.tsx.
import {
  act,
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
import type {
  RunTranscript,
  TranscriptKind,
  TranscriptZoom,
} from "@/data/contracts/run";
import type { Cost } from "@/data/contracts/money";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runTranscript, transcriptEntry } from "./run.builders";
import { formatDuration } from "@/ui/money-format";

const { readTranscriptPage } = vi.hoisted(() => ({
  readTranscriptPage: vi.fn(),
}));
vi.mock("./actions", () => ({ readTranscriptPage }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { RunPlayer } = await import("./player");

const RUN = "tse_7k2m9q";

/** A fake EventSource: records instances and lets a test fire `onopen`. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function renderPlayer(
  overrides: {
    first?: RunTranscript;
    live?: boolean;
    zoom?: TranscriptZoom;
    kinds?: readonly TranscriptKind[];
  } = {},
) {
  return render(
    <IntlProvider>
      <RunPlayer
        first={overrides.first ?? runTranscript()}
        zoom={overrides.zoom ?? "steps"}
        kinds={overrides.kinds ?? []}
        live={overrides.live ?? false}
        org="acme"
        ws="core-platform"
        runId={RUN}
      />
    </IntlProvider>,
  );
}

/** The `seq` of the entry the playhead currently stands on, or null. */
function currentSeq(): string | null {
  const node = document.querySelector(
    '[data-testid="transcript-entry"][data-current="true"]',
  );
  return node?.getAttribute("data-seq") ?? null;
}

function entriesRun(count: number, extra: Partial<RunTranscript> = {}) {
  return runTranscript({
    entries: Array.from({ length: count }, (_, i) =>
      transcriptEntry({ seq: String(i + 1) }),
    ),
    ...extra,
  });
}

beforeEach(() => {
  readTranscriptPage.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the playhead", () => {
  it("starts on the first entry and names its seq in the readout, cleanly", async () => {
    const entries = [
      transcriptEntry({ seq: "1", elapsedMs: 0 }),
      transcriptEntry({ seq: "2", elapsedMs: 500 }),
      transcriptEntry({ seq: "3", elapsedMs: 900 }),
    ];
    const { container } = renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    expect(currentSeq()).toBe("1");
    expect(screen.getByTestId("player-position")).toHaveTextContent(
      "frame 1",
    );
    expect(screen.getByTestId("player-position")).toHaveTextContent(
      "entry 1 of 3",
    );
    await expectNoAxe(container);
  });

  it("steps forward and back one entry, and first/last jump to the ends", async () => {
    const entries = [
      transcriptEntry({ seq: "1" }),
      transcriptEntry({ seq: "2" }),
      transcriptEntry({ seq: "3" }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("player-forward"));
    expect(currentSeq()).toBe("2");
    await user.click(screen.getByTestId("player-back"));
    expect(currentSeq()).toBe("1");
    await user.click(screen.getByTestId("player-last"));
    expect(currentSeq()).toBe("3");
    await user.click(screen.getByTestId("player-first"));
    expect(currentSeq()).toBe("1");
  });

  it("the scrub input spans the entries and moving it moves the playhead", () => {
    const entries = [
      transcriptEntry({ seq: "1" }),
      transcriptEntry({ seq: "2" }),
      transcriptEntry({ seq: "3" }),
      transcriptEntry({ seq: "4" }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    const scrub = screen.getByTestId("player-scrub");
    expect(scrub).toHaveAttribute("max", "3");
    fireEvent.change(scrub, { target: { value: "2" } });
    expect(currentSeq()).toBe("3");
  });

  // NOTE: `spentSoFar` is `"{cost} spent so far"` (a plain ICU placeholder),
  // but player.tsx calls `t.rich("spentSoFar", { cost: () => <Money .../> })`
  // — a rich-text tag renderer, which next-intl only invokes for a `<tag/>`
  // in the message, not a `{placeholder}`. React logs "Functions are not
  // valid as a React child" and drops the value, so the dollar figure never
  // reaches the DOM regardless of which entry the playhead is on. This is a
  // real defect (see the test file's final report), so this test proves what
  // currently is true — the readout switches off the null-cost sentence once
  // an entry carries a figure — rather than asserting the (currently
  // unreachable) dollar amount.
  it("switches from the no-cost sentence to the spent-so-far line once the playhead reaches a priced entry", async () => {
    const costA: Cost = {
      micros: "1000000",
      currency: "USD",
      basis: "gateway_observed",
    };
    const entries = [
      transcriptEntry({ seq: "1", cumulativeCost: null }),
      transcriptEntry({ seq: "2", cumulativeCost: costA }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    expect(screen.getByTestId("player-position")).toHaveTextContent(
      "nothing priced up to here",
    );
    expect(screen.queryByTestId("player-cost")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("player-forward"));
    const line = screen.getByTestId("player-cost");
    // The figure itself, not just the words around it. `t.rich` silently drops
    // a value passed as a function when the message carries a plain `{cost}`
    // placeholder, so a readout that says "spent so far" and no money at all
    // passes every assertion about its prose.
    expect(within(line).getByTestId("money")).toHaveTextContent(/\d/);
    expect(line).toHaveTextContent("spent so far");
    expect(screen.getByTestId("player-position")).not.toHaveTextContent(
      "nothing priced up to here",
    );
  });
});

describe("playback", () => {
  it("play advances the playhead after the recorded gap at 1x", async () => {
    vi.useFakeTimers();
    const entries = [
      transcriptEntry({ seq: "1", elapsedMs: 0 }),
      transcriptEntry({ seq: "2", elapsedMs: 1000 }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    // userEvent's internal pointer-sequence delays never resolve under fake
    // timers even with `delay: null`/`advanceTimers` configured, so playback
    // interactions use `fireEvent`, which dispatches synchronously.
    fireEvent.click(screen.getByTestId("player-play"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(currentSeq()).toBe("1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(currentSeq()).toBe("2");
  });

  it("divides the gap by the speed: at 2x the same 1000ms gap advances in 500ms", async () => {
    vi.useFakeTimers();
    const entries = [
      transcriptEntry({ seq: "1", elapsedMs: 0 }),
      transcriptEntry({ seq: "2", elapsedMs: 1000 }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    fireEvent.click(screen.getByTestId("player-speed-2"));
    fireEvent.click(screen.getByTestId("player-play"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(currentSeq()).toBe("1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(currentSeq()).toBe("2");
  });

  it("caps a gap longer than the idle limit at 2000ms and states the true gap", async () => {
    vi.useFakeTimers();
    const entries = [
      transcriptEntry({ seq: "1", elapsedMs: 0 }),
      transcriptEntry({ seq: "2", elapsedMs: 40_000 }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    const idle = screen.getByTestId("player-idle");
    expect(idle).toHaveTextContent(formatDuration(40_000, "en"));
    expect(idle).toHaveTextContent(formatDuration(2000, "en"));
    fireEvent.click(screen.getByTestId("player-play"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(currentSeq()).toBe("1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(currentSeq()).toBe("2");
  });

  it("pausing stops the advance (negative)", async () => {
    vi.useFakeTimers();
    const entries = [
      transcriptEntry({ seq: "1", elapsedMs: 0 }),
      transcriptEntry({ seq: "2", elapsedMs: 1000 }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
    });
    fireEvent.click(screen.getByTestId("player-play"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.click(screen.getByTestId("player-play"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(currentSeq()).toBe("1");
  });

  it("offers no stop control (negative)", () => {
    renderPlayer();
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });
});

describe("pagination", () => {
  it("draws Read more only when the page carried a cursor, and none when it is null (negative)", () => {
    renderPlayer({ first: entriesRun(6, { cursor: "cur_1", complete: false }) });
    expect(screen.getByTestId("transcript-more")).toBeInTheDocument();
    cleanup();
    renderPlayer({ first: runTranscript({ cursor: null, complete: true }) });
    expect(screen.queryByTestId("transcript-more")).toBeNull();
  });

  it("pressing Read more calls readTranscriptPage with the cursor and appends entries without dropping the ones already shown", async () => {
    readTranscriptPage.mockResolvedValue({
      ok: true,
      value: runTranscript({
        entries: [transcriptEntry({ seq: "7" }), transcriptEntry({ seq: "8" })],
        cursor: null,
        complete: true,
      }),
    });
    renderPlayer({
      first: entriesRun(6, { cursor: "cur_1", complete: false }),
      zoom: "steps",
      kinds: ["responses"],
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getAllByTestId("transcript-entry")).toHaveLength(8);
    });
    const seqs = screen
      .getAllByTestId("transcript-entry")
      .map((el) => el.getAttribute("data-seq"));
    expect(seqs).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(readTranscriptPage).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      RUN,
      "steps",
      ["responses"],
      "cur_1",
    );
  });

  it("a refused page with code invalid_input renders the badCursor sentence and keeps every entry already loaded (negative)", async () => {
    readTranscriptPage.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "invalid_input",
      status: 400,
    });
    renderPlayer({ first: entriesRun(6, { cursor: "cur_1", complete: false }) });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getByTestId("player-read-failed")).toHaveTextContent(
        "That resume point is not one this read wrote",
      );
    });
    expect(screen.getAllByTestId("transcript-entry")).toHaveLength(6);
  });

  it("a refusal with any other code renders the pageFailed sentence", async () => {
    readTranscriptPage.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "unavailable",
      status: 503,
    });
    renderPlayer({ first: entriesRun(6, { cursor: "cur_1", complete: false }) });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getByTestId("player-read-failed")).toHaveTextContent(
        "The next page could not be read.",
      );
    });
  });

  it("the loaded-count line says the run is complete when the page says complete", () => {
    renderPlayer({
      first: runTranscript({
        entries: [transcriptEntry()],
        cursor: null,
        complete: true,
      }),
    });
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "This is the whole run.",
    );
  });

  it("the loaded-count line says more lies behind the page when it is not complete", () => {
    renderPlayer({ first: entriesRun(6, { cursor: "cur_1", complete: false }) });
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "The run has more behind this page.",
    );
  });
});

describe("live run following", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the follow line reflecting the stream state on a live run", () => {
    const entries = [
      transcriptEntry({ seq: "1" }),
      transcriptEntry({ seq: "2" }),
      transcriptEntry({ seq: "3" }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
      live: true,
    });
    const es = FakeEventSource.instances[0];
    expect(es).toBeDefined();
    act(() => {
      es?.onopen?.();
    });
    expect(screen.getByTestId("player-follow")).toHaveTextContent(
      "Following the live head. New entries arrive as the run records them.",
    );
    expect(screen.getByTestId("player-follow")).toHaveAttribute(
      "data-attached",
      "true",
    );
  });

  it("scrubbing backwards detaches from the head, and reattach returns the playhead to the last entry", async () => {
    const entries = [
      transcriptEntry({ seq: "1" }),
      transcriptEntry({ seq: "2" }),
      transcriptEntry({ seq: "3" }),
    ];
    renderPlayer({
      first: runTranscript({ entries, cursor: null, complete: true }),
      live: true,
    });
    const es = FakeEventSource.instances[0];
    act(() => {
      es?.onopen?.();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("player-forward"));
    await user.click(screen.getByTestId("player-back"));
    expect(screen.getByTestId("player-follow")).toHaveAttribute(
      "data-attached",
      "false",
    );
    expect(screen.getByTestId("player-follow")).toHaveTextContent(
      "You are reading back through the recording.",
    );
    await user.click(screen.getByTestId("player-reattach"));
    expect(currentSeq()).toBe("3");
    expect(screen.getByTestId("player-follow")).toHaveAttribute(
      "data-attached",
      "true",
    );
  });

  it("draws no follow line at all on a sealed (non-live) run (negative)", () => {
    renderPlayer({ live: false });
    expect(screen.queryByTestId("player-follow")).toBeNull();
  });
});
