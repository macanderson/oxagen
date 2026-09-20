// @vitest-environment jsdom
// The one state badge: a tone is a state hue on the ink, the border and the
// wash; the dot is on by default and off for a fact; a data attribute the
// caller passes reaches the element, because every page reads the state off it.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge";

afterEach(cleanup);

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

  it("`.b` is a bordered pill: the hairline and 6px corners (INV-32)", () => {
    render(<Badge tone="allowed">live</Badge>);
    const pill = screen.getByText("live");
    expect(pill.className).toContain("border");
    expect(pill.className).toContain("rounded-md");
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
      render(<Badge tone={tone}>{tone}</Badge>);
      expect(screen.getByText(tone).className).not.toMatch(/gold|brand|ember/);
      cleanup();
    }
  });
});
