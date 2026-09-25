// @vitest-environment jsdom
// The frame player's play, pause and speed, driven the way the Run page
// drives them: each step is a navigation, and the page renders the bar again
// at the frame that landed. The rerender stands in for that landing, so the
// tests can hold play to one read at a time. Play replaces the history entry
// and keeps the scroll; a step by hand pushes one.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathOf, type SafePath } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const push = vi.fn();
const replace = vi.fn();
const router = { push, replace, refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/shell/client", () => ({ openApprovals: vi.fn() }));

const { PlayButton, PlayerPlayback, PlayerScrub, PlaySpeed, stepMs } =
  await import("./frame-player");

const HREFS = ["0", "1", "2", "3"].map((seq) => pathOf("f", seq));
// Holds of 1 s, 5 s (a 10 s gap, capped), and 250 ms (no time recorded).
const TIMES = [0, 1000, 11_000, Number.NaN];

function bar(index: number, hrefs: readonly SafePath[] = HREFS) {
  return (
    <IntlProvider>
      <PlayerPlayback
        hrefs={hrefs}
        times={TIMES}
        index={index}
        steps={{
          first: hrefs[0] ?? null,
          prev: hrefs[index - 1] ?? null,
          next: hrefs[index + 1] ?? null,
          last: hrefs.at(-1) ?? null,
        }}
        label="Frame player"
        className=""
      >
        <a
          href="#first"
          data-testid="step-link"
          onClick={(event) => {
            event.preventDefault();
          }}
        >
          first
        </a>
        <PlayButton />
        <PlayerScrub key={index} hrefs={hrefs} index={index} marks={[]} />
        <PlaySpeed />
      </PlayerPlayback>
    </IntlProvider>
  );
}

const play = () => screen.getByTestId("player-play");
/** The frames play opened, in order. */
const played = () => replace.mock.calls.map(([path]) => path);
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  push.mockClear();
  replace.mockClear();
});

describe("stepMs", () => {
  it("holds each frame for its recorded gap, between 250 ms and 5 s, over the speed", () => {
    expect(stepMs(0, 1000, 1)).toBe(1000);
    expect(stepMs(0, 10_000, 1)).toBe(5000);
    expect(stepMs(0, 100, 1)).toBe(250);
    expect(stepMs(0, 4000, 4)).toBe(1000);
    expect(stepMs(0, 100, 16)).toBe(15.625);
  });

  it("holds the 250 ms floor where a time is missing, unreadable or out of order (negative)", () => {
    expect(stepMs(undefined, 1000, 1)).toBe(250);
    expect(stepMs(0, undefined, 1)).toBe(250);
    expect(stepMs(0, Number.NaN, 1)).toBe(250);
    expect(stepMs(5000, 1000, 1)).toBe(250);
  });
});

describe("play", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("opens each frame after its hold, waits for it to land, and offers a replay at the last", () => {
    const view = render(bar(0));
    expect(play()).toHaveAccessibleName("play");
    fireEvent.click(play());
    expect(play()).toHaveAccessibleName("pause");
    advance(999);
    expect(replace).not.toHaveBeenCalled();
    advance(1);
    // Play replaces the entry and keeps the scroll, so a long run adds one
    // history entry for the whole playback and the page does not jump.
    expect(replace).toHaveBeenLastCalledWith(HREFS[1], { scroll: false });
    // The frame has not landed, so play reads nothing more.
    advance(10_000);
    expect(played()).toHaveLength(1);
    view.rerender(bar(1));
    advance(4999);
    expect(played()).toHaveLength(1);
    advance(1);
    expect(played().at(-1)).toBe(HREFS[2]);
    view.rerender(bar(2));
    advance(250);
    expect(played().at(-1)).toBe(HREFS[3]);
    view.rerender(bar(3));
    expect(play()).toHaveAccessibleName("replay");
    advance(10_000);
    expect(played()).toHaveLength(3);
    // Replay starts over from the first frame and plays on from there.
    fireEvent.click(play());
    expect(played().at(-1)).toBe(HREFS[0]);
    view.rerender(bar(0));
    expect(play()).toHaveAccessibleName("pause");
    advance(1000);
    expect(played().at(-1)).toBe(HREFS[1]);
    expect(push).not.toHaveBeenCalled();
  });

  it("holds the open frame once paused (negative)", () => {
    render(bar(0));
    fireEvent.click(play());
    fireEvent.click(play());
    expect(play()).toHaveAccessibleName("play");
    advance(10_000);
    expect(replace).not.toHaveBeenCalled();
  });

  it("divides each hold by the speed pressed", () => {
    render(bar(0));
    const speeds = within(
      screen.getByRole("group", { name: "Playback speed" }),
    );
    expect(speeds.getByRole("button", { name: "1×" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(speeds.getByRole("button", { name: "16×" }));
    expect(speeds.getByRole("button", { name: "16×" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(speeds.getByRole("button", { name: "1×" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(play());
    // The first hold is the 1 s gap over 16, so 62.5 ms. The fake clock
    // truncates a fractional delay when the timer is set, which puts the
    // boundary it can express at 62 rather than at 63; `stepMs` above pins the
    // arithmetic itself, including its fractional case. What this asserts is
    // that play uses the divided hold and not the 1 s one.
    advance(61);
    expect(replace).not.toHaveBeenCalled();
    advance(1);
    expect(played().at(-1)).toBe(HREFS[1]);
  });

  it("plays and pauses on space, and leaves space to a field or a focused button", () => {
    render(bar(0));
    // The page does not scroll: the handler takes the key.
    expect(fireEvent.keyDown(document.body, { key: " " })).toBe(false);
    expect(play()).toHaveAccessibleName("pause");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Frame" }), {
      key: " ",
    });
    fireEvent.keyDown(play(), { key: " " });
    fireEvent.keyDown(document.body, { key: " ", ctrlKey: true });
    expect(play()).toHaveAccessibleName("pause");
    fireEvent.keyDown(document.body, { key: " " });
    expect(play()).toHaveAccessibleName("play");
  });

  it("stops at a step by key or by link, and plays on through a scrub", () => {
    render(bar(1));
    fireEvent.click(play());
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(push).toHaveBeenLastCalledWith(HREFS[2]);
    expect(play()).toHaveAccessibleName("play");
    advance(10_000);
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(play());
    fireEvent.click(screen.getByTestId("step-link"));
    expect(play()).toHaveAccessibleName("play");
    fireEvent.click(play());
    const range = screen.getByRole("slider", { name: "Frame" });
    fireEvent.change(range, { target: { value: "3" } });
    fireEvent.pointerUp(range);
    expect(push).toHaveBeenLastCalledWith(HREFS[3]);
    expect(play()).toHaveAccessibleName("pause");
  });

  it("does not start again when a scrub leaves the last frame after play ran out (negative)", () => {
    const view = render(bar(0));
    fireEvent.click(play());
    view.rerender(bar(3));
    expect(play()).toHaveAccessibleName("replay");
    const range = screen.getByRole("slider", { name: "Frame" });
    fireEvent.change(range, { target: { value: "1" } });
    fireEvent.pointerUp(range);
    expect(push).toHaveBeenLastCalledWith(HREFS[1]);
    view.rerender(bar(1));
    expect(play()).toHaveAccessibleName("play");
    advance(10_000);
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not start again when a frame opens after play ran out (negative)", () => {
    const view = render(bar(2));
    fireEvent.click(play());
    advance(250);
    expect(played().at(-1)).toBe(HREFS[3]);
    view.rerender(bar(3));
    expect(play()).toHaveAccessibleName("replay");
    // A row of the frame list, or the browser's Back, opens an earlier frame.
    view.rerender(bar(1));
    expect(play()).toHaveAccessibleName("play");
    advance(10_000);
    expect(played()).toHaveLength(1);
  });

  it("stops at a frame it did not open, and stays stopped on a return to the frame it left (negative)", () => {
    const view = render(bar(0));
    fireEvent.click(play());
    view.rerender(bar(2));
    expect(play()).toHaveAccessibleName("play");
    view.rerender(bar(0));
    expect(play()).toHaveAccessibleName("play");
    advance(10_000);
    expect(replace).not.toHaveBeenCalled();
  });

  it("starts from the first frame when the page does not hold the open one", () => {
    const view = render(bar(-1));
    fireEvent.click(play());
    expect(played().at(-1)).toBe(HREFS[0]);
    expect(play()).toHaveAccessibleName("pause");
    view.rerender(bar(0));
    advance(1000);
    expect(played().at(-1)).toBe(HREFS[1]);
  });

  it("has nothing to play on a page of one frame (negative)", () => {
    render(bar(0, HREFS.slice(0, 1)));
    expect(play()).toBeDisabled();
    expect(play()).toHaveAccessibleName("play");
    fireEvent.keyDown(document.body, { key: " " });
    advance(10_000);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("the play controls", () => {
  it("pass axe", async () => {
    const { container } = render(bar(1));
    await expectNoAxe(container);
  });
});
