// @vitest-environment jsdom
/**
 * activity-timeline.test.tsx
 *
 * Render tests for ActivityTimeline and TimelineItem:
 *   - ActivityTimeline renders children
 *   - TimelineItem renders children
 *   - TimelineItem applies the correct tone via data-tone
 *   - TimelineItem shows pulsing ring when isActive=true (reduced motion off)
 *   - TimelineItem hides connector line when isLast=true
 *   - Multiple items are stacked in order
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      variants: _variants,
      initial: _initial,
      animate: _animate,
      className,
      "data-component": dataComponent,
      "data-tone": dataTone,
      ...rest
    }: React.HTMLAttributes<HTMLDivElement> & {
      variants?: unknown;
      initial?: unknown;
      animate?: unknown;
      "data-component"?: string;
      "data-tone"?: string;
    }) => (
      <div
        className={className}
        data-component={dataComponent}
        data-tone={dataTone}
        {...rest}
      >
        {children}
      </div>
    ),
  },
  useReducedMotion: () => false, // use real motion in these tests
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@oxagen/ui/lib/motion", () => ({
  fadeInUp: { hidden: { opacity: 0 }, visible: { opacity: 1 } },
  staggerContainer: { hidden: { opacity: 0 }, visible: { opacity: 1 } },
}));

describe("ActivityTimeline", () => {
  it("renders children inside the timeline wrapper", async () => {
    const { ActivityTimeline } = await import("./activity-timeline");
    render(
      <ActivityTimeline>
        <div data-testid="child">Step 1</div>
      </ActivityTimeline>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("renders multiple children", async () => {
    const { ActivityTimeline } = await import("./activity-timeline");
    render(
      <ActivityTimeline>
        <div data-testid="c1">One</div>
        <div data-testid="c2">Two</div>
        <div data-testid="c3">Three</div>
      </ActivityTimeline>,
    );
    expect(screen.getByTestId("c1")).toBeInTheDocument();
    expect(screen.getByTestId("c2")).toBeInTheDocument();
    expect(screen.getByTestId("c3")).toBeInTheDocument();
  });

  it("applies custom className", async () => {
    const { ActivityTimeline } = await import("./activity-timeline");
    const { container } = render(
      <ActivityTimeline className="custom-timeline">
        <div>Step</div>
      </ActivityTimeline>,
    );
    expect(container.firstChild).toHaveClass("custom-timeline");
  });
});

describe("TimelineItem", () => {
  it("renders children content", async () => {
    const { TimelineItem } = await import("./activity-timeline");
    render(
      <TimelineItem>
        <span>My item content</span>
      </TimelineItem>,
    );
    expect(screen.getByText("My item content")).toBeInTheDocument();
  });

  it("has data-tone attribute matching tone prop", async () => {
    const { TimelineItem } = await import("./activity-timeline");
    render(
      <TimelineItem tone="done">
        <span>Done step</span>
      </TimelineItem>,
    );
    expect(document.querySelector("[data-tone='done']")).toBeInTheDocument();
  });

  it("defaults to tone=idle", async () => {
    const { TimelineItem } = await import("./activity-timeline");
    render(
      <TimelineItem>
        <span>Idle step</span>
      </TimelineItem>,
    );
    expect(document.querySelector("[data-tone='idle']")).toBeInTheDocument();
  });

  it("shows pulsing ring when isActive=true", async () => {
    const { TimelineItem } = await import("./activity-timeline");
    render(
      <TimelineItem isActive={true} tone="running">
        <span>Active step</span>
      </TimelineItem>,
    );
    // The pulsing ring is aria-hidden; find it by animate-ping class
    const pingEl = document.querySelector(".animate-ping");
    expect(pingEl).toBeInTheDocument();
  });

  it("does not show pulsing ring when isActive=false", async () => {
    const { TimelineItem } = await import("./activity-timeline");
    render(
      <TimelineItem isActive={false} tone="running">
        <span>Inactive step</span>
      </TimelineItem>,
    );
    expect(document.querySelector(".animate-ping")).not.toBeInTheDocument();
  });

  it("shows connector line when isLast=false", async () => {
    const { TimelineItem } = await import("./activity-timeline");
    render(
      <TimelineItem isLast={false}>
        <span>Middle step</span>
      </TimelineItem>,
    );
    // Connector line: w-px class
    expect(document.querySelector(".w-px")).toBeInTheDocument();
  });

  it("hides connector line when isLast=true", async () => {
    const { TimelineItem } = await import("./activity-timeline");
    render(
      <TimelineItem isLast={true}>
        <span>Last step</span>
      </TimelineItem>,
    );
    // No connector line
    expect(document.querySelector(".w-px")).not.toBeInTheDocument();
  });
});
