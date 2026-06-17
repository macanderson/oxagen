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
  it("default variant includes bg-primary", () => {
    expect(badgeVariants({})).toContain("bg-primary");
  });
  it("secondary variant includes bg-secondary", () => {
    expect(badgeVariants({ variant: "secondary" })).toContain("bg-secondary");
  });
  it("destructive variant includes bg-destructive", () => {
    expect(badgeVariants({ variant: "destructive" })).toContain("bg-destructive");
  });
  it("outline variant is the token-driven surface chip (badge-bg/fg/border)", () => {
    const cls = badgeVariants({ variant: "outline" });
    expect(cls).toContain("bg-badge-bg");
    expect(cls).toContain("text-badge-fg");
    expect(cls).toContain("border-badge-border");
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

  it("render-prop forwards children through a custom element", () => {
    render(
      <Badge render={<button type="button" />}>Action</Badge>
    );
    const btn = screen.getByRole("button", { name: "Action" });
    expect(btn).toBeInTheDocument();
    // Variant classes forwarded to the rendered element
    expect(btn.className).toContain("bg-primary");
  });
});
