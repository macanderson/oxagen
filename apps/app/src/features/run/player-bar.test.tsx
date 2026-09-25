// @vitest-environment jsdom
// The frame player bar's playback (mockup `fpBar`, `fpPlay`, `fpTick`,
// `fpSpeed`), rendered the way the Governed actions tab renders it and driven
// on fake timers. Each navigation the playback asks for is a `replace` the
// test answers by rendering the bar at that frame, so the test holds the rule
// that playback waits for a frame to land before it counts the next gap.
//
// The rules: each frame is held for its recorded gap to the next, between
// 250 ms and 5 s, divided by the speed; playback stops on the last frame and
// plays again from the first; space plays and pauses unless focus is on a
// field or a control, and is left to scroll the page when there is nothing to
// play; a step taken by hand (a key, a frame's link, the scrub) stops it; and
// no timer outlives the bar.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFrame } from "@/data/contracts/run";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runFrame } from "./run.builders";

const router = vi.hoisted(() => ({
  push: vi.fn<(path: string) => void>(),
  // `advance` replaces with `scroll: false`, so the options argument is typed
  // here too: untyped, `mock.calls` is `any[][]` and reading a call is unsafe.
  replace: vi.fn<(path: string, options?: { scroll?: boolean }) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock("next/link", () => ({
  // Next's link navigates on the client: it cancels the browser's own
  // navigation and pushes the route, which the test reads off `router.push`.
  default: ({
    children,
    href,
    ...rest
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        router.push(href);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/shell/client", () => ({ openApprovals: vi.fn() }));

const { PlayerBar } = await import("./player-bar");
const { openFrameOf, playbackGaps, stepsOf } = await import("./player-model");
const { SafeLink } = await import("@/ui/navigation");

const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const frameAt = (seq: string, ms: number): RunFrame =>
  runFrame({
    seq,
    cursor: `c${seq}`,
    observedAt: new Date(T0 + ms).toISOString(),
  });

/**
 * Four frames whose gaps test each bound: 1.2 s is held as recorded, 10 ms is
 * held at the 250 ms floor, and 30 s at the 5 s cap.
 */
const FRAMES = [
  frameAt("0", 0),
  frameAt("1", 1200),
  frameAt("2", 1210),
  frameAt("3", 31_210),
];

const hrefOf = (seq: string) =>
  routes.run("acme", "core", "tse_7k2m9q", { tab: "actions", body: seq });

function Bar({
  body,
  frames = FRAMES,
}: {
  body: string;
  frames?: readonly RunFrame[];
}) {
  const open = openFrameOf(frames, body);
  if (open === null) throw new Error("the fixture opens no frame");
  const steps = stepsOf(frames, open);
  const target = (seq: string | null) => (seq === null ? null : hrefOf(seq));
  return (
    <IntlProvider>
      <PlayerBar
        frames={frames}
        open={open}
        steps={{
          first: target(steps.first),
          prev: target(steps.prev),
          next: target(steps.next),
          last: target(steps.last),
        }}
        hrefs={frames.map((frame) => hrefOf(frame.seq))}
        gaps={playbackGaps(frames)}
        marks={frames.map(() => null)}
        spent={null}
        total={null}
        at={open.frame?.observedAt ?? null}
      />
    </IntlProvider>
  );
}

function renderBar(body: string) {
  const view = render(<Bar body={body} />);
  /** The frame the playback asked for lands: the page renders at it. */
  const land = (seq: string) => {
    view.rerender(<Bar body={seq} />);
  };
  return { ...view, land };
}

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const playButton = () => screen.getByTestId("player-play");
const asked = () => router.replace.mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  router.push.mockClear();
  router.replace.mockClear();
});

describe("the player bar's playback", () => {
  it("holds each frame for its recorded gap, waits for it to land, and stops on the last frame", () => {
    const { land } = renderBar("0");
    expect(playButton()).toHaveTextContent("▶play");
    fireEvent.click(playButton());
    expect(playButton()).toHaveTextContent("❙❙pause");

    advance(1199);
    expect(router.replace).not.toHaveBeenCalled();
    advance(1);
    expect(router.replace).toHaveBeenLastCalledWith(hrefOf("1"), {
      scroll: false,
    });
    // The frame has not landed, so no further step is asked for.
    advance(10_000);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(playButton()).toHaveTextContent("pause");

    land("1");
    advance(249);
    expect(router.replace).toHaveBeenCalledTimes(1);
    advance(1);
    expect(asked()).toEqual([hrefOf("1"), hrefOf("2")]);

    land("2");
    advance(4999);
    expect(router.replace).toHaveBeenCalledTimes(2);
    advance(1);
    expect(asked()).toEqual([hrefOf("1"), hrefOf("2"), hrefOf("3")]);

    land("3");
    expect(playButton()).toHaveTextContent("▶replay");
    advance(60_000);
    expect(router.replace).toHaveBeenCalledTimes(3);
  });

  it("plays again from the first frame at the last one", () => {
    const { land } = renderBar("3");
    expect(playButton()).toHaveTextContent("replay");
    fireEvent.click(playButton());
    expect(asked()).toEqual([hrefOf("0")]);
    expect(playButton()).toHaveTextContent("pause");
    // Still on the last frame until the first one lands: nothing more is asked.
    advance(10_000);
    expect(router.replace).toHaveBeenCalledTimes(1);

    land("0");
    expect(playButton()).toHaveTextContent("pause");
    advance(1200);
    expect(asked()).toEqual([hrefOf("0"), hrefOf("1")]);
  });

  it("pauses, and a paused playback asks for nothing", () => {
    renderBar("0");
    fireEvent.click(playButton());
    advance(600);
    fireEvent.click(playButton());
    expect(playButton()).toHaveTextContent("▶play");
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("divides the gap by the speed, 1×, 4× or 16×, with the one playing pressed", () => {
    const { land } = renderBar("0");
    const speeds = screen.getByRole("group", { name: "Playback speed" });
    expect(
      within(speeds)
        .getAllByRole("button")
        .map((button) => [
          button.textContent,
          button.getAttribute("aria-pressed"),
        ]),
    ).toEqual([
      ["1×", "true"],
      ["4×", "false"],
      ["16×", "false"],
    ]);

    const fourTimes = within(speeds).getByRole("button", { name: "4×" });
    fireEvent.click(fourTimes);
    expect(fourTimes).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(playButton());
    // 1200 ms at 4×.
    advance(299);
    expect(router.replace).not.toHaveBeenCalled();
    advance(1);
    expect(asked()).toEqual([hrefOf("1")]);

    // A new speed while playing takes the next gap: 250 ms at 16×.
    fireEvent.click(within(speeds).getByRole("button", { name: "16×" }));
    land("1");
    advance(15);
    expect(router.replace).toHaveBeenCalledTimes(1);
    advance(1);
    expect(asked()).toEqual([hrefOf("1"), hrefOf("2")]);
  });

  it("plays and pauses on space, but not while focus is in a field or on a control", () => {
    renderBar("0");
    // The toggle takes the key, so the page does not scroll as well.
    expect(fireEvent.keyDown(document.body, { key: " " })).toBe(false);
    expect(playButton()).toHaveTextContent("pause");
    fireEvent.keyDown(document.body, { key: " " });
    expect(playButton()).toHaveTextContent("play");

    const range = screen.getByRole("slider", { name: "Frame" });
    fireEvent.keyDown(range, { key: " " });
    expect(playButton()).toHaveTextContent("▶play");
    // Space on a button presses that button, so the document does not toggle too.
    fireEvent.keyDown(screen.getByRole("button", { name: "4×" }), {
      key: " ",
    });
    expect(playButton()).toHaveTextContent("▶play");
    // A held key repeats; only its first press toggles.
    fireEvent.keyDown(document.body, { key: " ", repeat: true });
    expect(playButton()).toHaveTextContent("▶play");
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("stops when a key steps by hand", () => {
    renderBar("0");
    fireEvent.keyDown(document.body, { key: " " });
    expect(playButton()).toHaveTextContent("pause");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(router.push).toHaveBeenLastCalledWith(hrefOf("1"));
    expect(playButton()).toHaveTextContent("▶play");
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("stops when a step button is clicked, and does not step again once that frame lands", () => {
    const { land } = renderBar("0");
    fireEvent.click(playButton());
    advance(600);
    fireEvent.click(screen.getByTestId("player-next"));
    expect(router.push).toHaveBeenLastCalledWith(hrefOf("1"));
    expect(playButton()).toHaveTextContent("▶play");
    // The gap that was running when the step was clicked asks for nothing.
    advance(10_000);
    land("1");
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
    expect(playButton()).toHaveTextContent("▶play");
  });

  it("stops when a link to one of the page's frames is followed outside the bar, and not for any other link", () => {
    const page = (body: string) => (
      <>
        <Bar body={body} />
        {/* The frame list's link to a frame on this page. */}
        <SafeLink to={hrefOf("2")}>frame 2</SafeLink>
        <SafeLink
          to={routes.run("acme", "core", "tse_other", {
            tab: "actions",
            body: "2",
          })}
        >
          another run
        </SafeLink>
      </>
    );
    const { rerender } = render(page("0"));
    fireEvent.click(playButton());
    advance(600);

    fireEvent.click(screen.getByRole("link", { name: "another run" }));
    expect(playButton()).toHaveTextContent("pause");
    // A link opened in a new tab leaves this one playing.
    fireEvent.click(screen.getByRole("link", { name: "frame 2" }), {
      metaKey: true,
    });
    expect(playButton()).toHaveTextContent("pause");

    fireEvent.click(screen.getByRole("link", { name: "frame 2" }));
    expect(router.push).toHaveBeenLastCalledWith(hrefOf("2"));
    expect(playButton()).toHaveTextContent("▶play");
    advance(10_000);
    rerender(page("2"));
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("stops when a person takes hold of the scrub, so a step never lands under the drag", () => {
    renderBar("0");
    fireEvent.click(playButton());
    advance(600);
    const range = screen.getByRole("slider", { name: "Frame" });
    fireEvent.pointerDown(range);
    expect(playButton()).toHaveTextContent("▶play");
    fireEvent.change(range, { target: { value: "2" } });
    // The gap that was running asks for nothing, so the range stays under the pointer.
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
    expect(range).toHaveValue("2");
    fireEvent.pointerUp(range);
    expect(router.push).toHaveBeenLastCalledWith(hrefOf("2"));
  });

  it("stops on a key that moves the scrub, and not on one that leaves it", () => {
    renderBar("0");
    fireEvent.click(playButton());
    const range = screen.getByRole("slider", { name: "Frame" });
    fireEvent.keyDown(range, { key: "Tab" });
    expect(playButton()).toHaveTextContent("pause");
    fireEvent.keyDown(range, { key: "ArrowRight" });
    expect(playButton()).toHaveTextContent("▶play");
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("leaves no timer behind when the bar goes", () => {
    const { unmount } = renderBar("0");
    fireEvent.click(playButton());
    unmount();
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("has nothing to play with one frame shown (negative)", () => {
    render(<Bar body="0" frames={[frameAt("0", 0)]} />);
    expect(playButton()).toBeDisabled();
    // Space is not taken, so it still scrolls the page.
    expect(fireEvent.keyDown(document.body, { key: " " })).toBe(true);
    advance(10_000);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("the player bar's transport", () => {
  it("draws first, previous, play, next, last, then the speeds and the keys, as the design's small buttons", async () => {
    vi.useRealTimers();
    const { container } = renderBar("1");
    const bar = screen.getByRole("group", { name: "Frame player" });
    expect(
      [...bar.querySelectorAll("[data-testid^='player-']")].map((el) =>
        el.getAttribute("data-testid"),
      ),
    ).toEqual([
      "player-first",
      "player-previous",
      "player-play",
      "player-next",
      "player-last",
      "player-position",
      "player-spent",
      "player-speeds",
    ]);
    // `.btn.sm`: a 7px radius at weight 500.
    for (const id of ["player-first", "player-play", "player-next"]) {
      expect(within(bar).getByTestId(id)).toHaveClass(
        "rounded-[7px]",
        "font-medium",
      );
    }
    expect(playButton()).toHaveAttribute(
      "title",
      "Play or pause the playback (space)",
    );
    expect(bar).toHaveTextContent("←→ step space play homeend");
    await expectNoAxe(container);
  });
});
