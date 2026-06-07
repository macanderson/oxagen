// @vitest-environment jsdom
/**
 * button.test.tsx — render tests for the Button component re-export.
 *
 * Covers: variant → class, size → class, render-prop composition, disabled state,
 * click handler, children forwarding.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { Button, buttonVariants } from "./button";

afterEach(cleanup);

// ── Variant map (no DOM) ────────────────────────────────────────────────────

describe("buttonVariants — class map", () => {
  it("includes the base classes for the default variant", () => {
    expect(buttonVariants({})).toContain("inline-flex");
    expect(buttonVariants({})).toContain("items-center");
    expect(buttonVariants({})).toContain("rounded-md");
  });
  it("default variant includes primary bg", () => {
    expect(buttonVariants({})).toContain("bg-primary");
  });
  it("outline variant includes border-input", () => {
    expect(buttonVariants({ variant: "outline" })).toContain("border-input");
  });
  it("secondary variant includes bg-secondary", () => {
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-secondary");
  });
  it("ghost variant includes hover:bg-accent", () => {
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-accent");
  });
  it("destructive variant includes bg-destructive", () => {
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-destructive");
  });
  it("link variant includes underline-offset-4", () => {
    expect(buttonVariants({ variant: "link" })).toContain("underline-offset-4");
  });
  it("destructive-outline variant includes text-destructive", () => {
    expect(buttonVariants({ variant: "destructive-outline" })).toContain("text-destructive");
  });

  it("xs size includes h-6", () => {
    expect(buttonVariants({ size: "xs" })).toContain("h-6");
  });
  it("sm size includes h-7", () => {
    expect(buttonVariants({ size: "sm" })).toContain("h-7");
  });
  it("default size includes h-8", () => {
    expect(buttonVariants({ size: "default" })).toContain("h-8");
  });
  it("lg size includes h-9", () => {
    expect(buttonVariants({ size: "lg" })).toContain("h-9");
  });
  it("xl size includes h-10", () => {
    expect(buttonVariants({ size: "xl" })).toContain("h-10");
  });
  it("icon size includes size-8", () => {
    expect(buttonVariants({ size: "icon" })).toContain("size-8");
  });
  it("icon-sm size includes size-7", () => {
    expect(buttonVariants({ size: "icon-sm" })).toContain("size-7");
  });
  it("icon-lg size includes size-9", () => {
    expect(buttonVariants({ size: "icon-lg" })).toContain("size-9");
  });

  it("merges a custom className without losing variant classes", () => {
    const cls = buttonVariants({ className: "custom-class" });
    expect(cls).toContain("custom-class");
    expect(cls).toContain("bg-primary");
  });
});

// ── Render tests (jsdom) ────────────────────────────────────────────────────

describe("Button — render", () => {
  it("renders a button element by default", () => {
    const { getByRole } = render(<Button>Click me</Button>);
    expect(getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("forwards children", () => {
    const { getByText } = render(<Button>Submit</Button>);
    expect(getByText("Submit")).toBeInTheDocument();
  });

  it("applies variant class to the rendered button", () => {
    const { getByRole } = render(<Button variant="outline">Outline</Button>);
    expect(getByRole("button", { name: "Outline" }).className).toContain("border-input");
  });

  it("applies size class to the rendered button", () => {
    const { getByRole } = render(<Button size="lg">Large</Button>);
    expect(getByRole("button", { name: "Large" }).className).toContain("h-9");
  });

  it("merges extra className", () => {
    const { getByRole } = render(<Button className="extra-cls">Btn</Button>);
    expect(getByRole("button", { name: "Btn" }).className).toContain("extra-cls");
  });

  it("fires onClick when clicked", async () => {
    const onClick = vi.fn();
    const { getByRole } = render(<Button onClick={onClick}>Click</Button>);
    await userEvent.click(getByRole("button", { name: "Click" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is disabled when disabled prop is set", () => {
    const { getByRole } = render(<Button disabled>Disabled</Button>);
    expect(getByRole("button", { name: "Disabled" })).toBeDisabled();
  });

  it("render-prop forwards children through an anchor element", () => {
    const { getByRole } = render(
      <Button render={<a href="/test" />}>Link Button</Button>
    );
    const anchor = getByRole("link", { name: "Link Button" });
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute("href", "/test");
    expect(anchor).toHaveTextContent("Link Button");
    expect(anchor.className).toContain("bg-primary");
  });

  it("type defaults to button (not submit) to prevent accidental form submission", () => {
    const { getByRole } = render(<Button>Safe</Button>);
    expect(getByRole("button", { name: "Safe" })).toHaveAttribute("type", "button");
  });
});
