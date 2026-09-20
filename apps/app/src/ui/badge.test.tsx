// @vitest-environment jsdom
// The one state badge: a tone is a state hue on the ink, the border and the
// wash; the dot is on by default and off for a fact; a data attribute the
// caller passes reaches the element, because every page reads the state off it.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("draws the tone on the ink, the border and the wash, with a dot", () => {
    render(
      <Badge tone="allowed" data-status="live">
        live
      </Badge>,
    );
    const pill = screen.getByText("live");
    expect(pill).toHaveAttribute("data-status", "live");
    expect(pill.className).toContain("text-success");
    expect(pill.className).toContain("border-success/40");
    expect(pill.className).toContain("bg-success/10");
    expect(pill.querySelector("[aria-hidden]")).not.toBeNull();
  });

  it("a quiet, mono badge is a fact: no dot, lowercase, the muted ink", () => {
    render(
      <Badge tone="quiet" dot={false} mono data-tier="harness">
        harness
      </Badge>,
    );
    const pill = screen.getByText("harness");
    expect(pill).toHaveAttribute("data-tier", "harness");
    expect(pill.className).toContain("text-muted-foreground");
    expect(pill.className).toContain("font-mono");
    expect(pill.querySelector("[aria-hidden]")).toBeNull();
  });

  it("never paints a state with the gold", () => {
    for (const tone of [
      "allowed",
      "approval",
      "denied",
      "proven",
      "failed",
      "critical",
      "quiet",
    ] as const) {
      const { unmount } = render(<Badge tone={tone}>{tone}</Badge>);
      expect(screen.getByText(tone).className).not.toMatch(/gold|brand|ember/);
      unmount();
    }
  });
});
