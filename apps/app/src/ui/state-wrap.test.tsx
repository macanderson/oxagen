// @vitest-environment jsdom
// The design's `.state-wrap`: the frame every not-loaded state draws. Each
// tone names one border colour and one ink, so the tone never loses to the
// neutral border; the glyph is the design's own SVG for the tone unless the
// caller names another; the heading labels the section; and a state with no
// actions draws no empty action row.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { StateWrap, stateFacts, stateTrace } from "./state-wrap";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function iconOf(testId: string): Element {
  const icon = screen.getByTestId(testId).querySelector("[data-state-icon]");
  if (icon === null) throw new Error("no state icon");
  return icon;
}

describe("StateWrap", () => {
  it("is the design's centred frame: glyph tile, h2, one paragraph, the actions", () => {
    render(
      <StateWrap
        testId="probe"
        tone="neutral"
        title="No runs yet"
        actions={<button type="button">Register an agent</button>}
      >
        Nothing has reached Oxagen from this workspace.
      </StateWrap>,
    );
    const state = screen.getByTestId("probe");
    expect(state.tagName).toBe("SECTION");
    expect(state).toHaveClass(
      "grid",
      "place-items-center",
      "px-5",
      "py-[60px]",
    );
    const heading = within(state).getByRole("heading", {
      level: 2,
      name: "No runs yet",
    });
    expect(heading).toHaveClass("mb-[7px]", "text-lg", "font-semibold");
    expect(state).toHaveAttribute("aria-labelledby", heading.id);
    expect(heading.id).toBe("probe-title");
    const body = within(state).getByText(
      "Nothing has reached Oxagen from this workspace.",
    );
    expect(body.tagName).toBe("P");
    expect(body).toHaveClass("max-w-[52ch]", "text-[13px]");
    expect(
      within(state).getByRole("button", { name: "Register an agent" })
        .parentElement,
    ).toHaveClass("flex", "flex-wrap", "justify-center", "gap-[9px]");
  });

  it("draws each tone with exactly one border colour", () => {
    render(
      <>
        <StateWrap testId="neutral" tone="neutral" title="Empty" />
        <StateWrap testId="failed" tone="failed" title="Failed" />
        <StateWrap testId="denied" tone="denied" title="Denied" />
      </>,
    );
    expect(iconOf("neutral")).toHaveClass("border-border", "text-foreground");
    expect(iconOf("failed")).toHaveClass("border-error/40", "text-error");
    expect(iconOf("failed")).not.toHaveClass("border-border");
    expect(iconOf("denied")).toHaveClass("border-warning/40", "text-warning");
    expect(iconOf("denied")).not.toHaveClass("border-border");
    for (const id of ["neutral", "failed", "denied"]) {
      expect(iconOf(id)).toHaveClass("size-11", "rounded-xl", "bg-card");
      expect(iconOf(id)).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("draws the design's glyph for each tone: the panel, the circled mark, the lock", () => {
    render(
      <>
        <StateWrap testId="neutral" tone="neutral" title="Empty" />
        <StateWrap testId="failed" tone="failed" title="Failed" />
        <StateWrap testId="denied" tone="denied" title="Denied" />
      </>,
    );
    expect(iconOf("neutral").querySelector("path")).toHaveAttribute(
      "d",
      "M3 10h18",
    );
    expect(iconOf("neutral").querySelector("svg")).toHaveAttribute(
      "stroke-width",
      "1.6",
    );
    expect(iconOf("failed").querySelector("path")).toHaveAttribute(
      "d",
      "M12 8v5M12 17h.01",
    );
    expect(iconOf("failed").querySelector("circle")).not.toBeNull();
    expect(iconOf("denied").querySelector("path")).toHaveAttribute(
      "d",
      "M8 10V7a4 4 0 0 1 8 0v3",
    );
  });

  it("takes another glyph when the caller names one: a request still waiting is the lock, neutral", () => {
    render(
      <StateWrap
        testId="pending"
        tone="neutral"
        glyph="lock"
        title="Waiting"
      />,
    );
    expect(iconOf("pending")).toHaveAttribute("data-state-icon", "neutral");
    expect(iconOf("pending")).toHaveClass("border-border");
    expect(iconOf("pending").querySelector("path")).toHaveAttribute(
      "d",
      "M8 10V7a4 4 0 0 1 8 0v3",
    );
  });

  it("is an h1 on a page with no other heading, and passes its data attributes through", () => {
    render(
      <StateWrap
        heading="h1"
        titleId="root-title"
        tone="neutral"
        title="Page not found"
        data-state="missing"
      />,
    );
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Page not found",
    });
    expect(heading.id).toBe("root-title");
    const state = heading.closest("section");
    expect(state).toHaveAttribute("data-state", "missing");
    expect(state).toHaveAttribute("aria-labelledby", "root-title");
  });

  it("draws no paragraph and no action row when it has neither (negative)", () => {
    render(<StateWrap testId="bare" tone="neutral" title="Nothing here" />);
    const state = screen.getByTestId("bare");
    expect(state.querySelector("p")).toBeNull();
    expect(state.querySelector(".gap-\\[9px\\]")).toBeNull();
  });

  it("draws what follows the actions: the trace line and the facts, on the design's recipes", () => {
    render(
      <StateWrap
        testId="after"
        tone="failed"
        title="Fleet could not be loaded"
        after={
          <>
            <p className={stateTrace}>2026-09-11 09:16:04Z</p>
            <dl className={stateFacts}>
              <dt>Needed</dt>
              <dd>fleet.read</dd>
            </dl>
          </>
        }
      />,
    );
    const state = screen.getByTestId("after");
    expect(within(state).getByText("2026-09-11 09:16:04Z")).toHaveClass(
      "font-mono",
      "text-[11.5px]",
      "text-dim",
      "mt-4",
    );
    expect(state.querySelector("dl")).toHaveClass(
      "mt-5",
      "max-w-[420px]",
      "text-left",
    );
  });
});
