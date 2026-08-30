// @vitest-environment jsdom
/**
 * badge.test.tsx — render tests for the Badge component.
 *
 * Covers: variant → class, size → class, children forwarding, render-prop.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, badgeVariants } from "./badge";

// ── Variant map ─────────────────────────────────────────────────────────────

describe("badgeVariants — class map", () => {
  it("default variant is the outlined ink chip (border-current, transparent bg)", () => {
    const cls = badgeVariants({});
    expect(cls).toContain("border-current");
    expect(cls).toContain("bg-transparent");
    expect(cls).toContain("text-foreground");
    // Never a filled primary/secondary surface, never monospace.
    expect(cls).not.toContain("bg-primary");
    expect(cls).not.toContain("bg-secondary");
    expect(cls).not.toContain("font-mono");
  });
  it("secondary variant includes bg-secondary", () => {
    expect(badgeVariants({ variant: "secondary" })).toContain("bg-secondary");
  });
  it("destructive variant includes bg-destructive", () => {
    expect(badgeVariants({ variant: "destructive" })).toContain(
      "bg-destructive",
    );
  });
  it("outline variant aliases the default outlined ink chip", () => {
    const cls = badgeVariants({ variant: "outline" });
    expect(cls).toContain("border-current");
    expect(cls).toContain("bg-transparent");
    expect(cls).toContain("text-foreground");
  });
  it("muted variant includes bg-muted", () => {
    expect(badgeVariants({ variant: "muted" })).toContain("bg-muted");
  });
  it("info variant includes bg-info", () => {
    expect(badgeVariants({ variant: "info" })).toContain("bg-info");
  });
  it("success variant includes bg-success", () => {
    expect(badgeVariants({ variant: "success" })).toContain("bg-success");
  });
  it("warning variant includes bg-warning", () => {
    expect(badgeVariants({ variant: "warning" })).toContain("bg-warning");
  });
  it("error variant maps to the bg-error status token", () => {
    expect(badgeVariants({ variant: "error" })).toContain("bg-error");
  });
  it("soft status variants use tinted fills with status ink", () => {
    const cls = badgeVariants({ variant: "success-soft" });
    expect(cls).toContain("bg-success/10");
    expect(cls).toContain("text-success");
    expect(badgeVariants({ variant: "warning-soft" })).toContain(
      "text-warning",
    );
    expect(badgeVariants({ variant: "error-soft" })).toContain("text-error");
    expect(badgeVariants({ variant: "info-soft" })).toContain("text-info");
  });
  it("base classes size embedded icons", () => {
    expect(badgeVariants({})).toContain("[&_svg]:size-3");
  });

  it("sm size includes text-[10px]", () => {
    expect(badgeVariants({ size: "sm" })).toContain("text-[10px]");
  });
  it("default size includes text-xs", () => {
    expect(badgeVariants({ size: "default" })).toContain("text-xs");
  });
  it("lg size includes text-xs with px-2.5", () => {
    const cls = badgeVariants({ size: "lg" });
    expect(cls).toContain("px-2.5");
    expect(cls).toContain("text-xs");
  });
});

// ── Render tests ─────────────────────────────────────────────────────────────

describe("Badge — render", () => {
  it("renders children inside a span by default", () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("applies variant class", () => {
    render(<Badge variant="secondary">Beta</Badge>);
    const el = screen.getByText("Beta");
    expect(el.className).toContain("bg-secondary");
  });

  it("applies size class", () => {
    render(<Badge size="sm">Sm</Badge>);
    const el = screen.getByText("Sm");
    expect(el.className).toContain("text-[10px]");
  });

  it("merges custom className", () => {
    render(<Badge className="my-badge">Tag</Badge>);
    const el = screen.getByText("Tag");
    expect(el.className).toContain("my-badge");
  });

  it("dot renders a leading currentColor dot", () => {
    render(
      <Badge variant="success-soft" dot>
        Active
      </Badge>,
    );
    const badge = screen.getByText("Active").closest("span");
    expect(badge?.querySelector(".rounded-full.bg-current")).not.toBeNull();
  });

  it("no dot by default", () => {
    render(<Badge>Plain</Badge>);
    const badge = screen.getByText("Plain");
    expect(badge.querySelector(".bg-current")).toBeNull();
  });

  it("render-prop forwards children through a custom element", () => {
    render(<Badge render={<button type="button" />}>Action</Badge>);
    const btn = screen.getByRole("button", { name: "Action" });
    expect(btn).toBeInTheDocument();
    // Variant classes forwarded to the rendered element
    expect(btn.className).toContain("border-current");
  });
});
