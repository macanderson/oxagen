// button.test.tsx — unit tests for Button variant map and buttonVariants().
//
// These tests exercise the cva() variant map directly via buttonVariants() so
// they run without a DOM renderer. Full render tests (Base UI `render`
// forwarding, event handlers) require @testing-library/react to be added as a
// devDependency — tracked separately.

import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("includes the base classes for the default variant", () => {
    const cls = buttonVariants({});
    expect(cls).toContain("inline-flex");
    expect(cls).toContain("items-center");
    expect(cls).toContain("rounded-md");
  });

  it("applies the default (primary) variant classes when no variant is specified", () => {
    const cls = buttonVariants({});
    expect(cls).toContain("bg-primary");
    expect(cls).toContain("text-primary-foreground");
  });

  it("applies outline variant classes", () => {
    const cls = buttonVariants({ variant: "outline" });
    expect(cls).toContain("border");
    expect(cls).toContain("border-input");
  });

  it("applies secondary variant classes", () => {
    const cls = buttonVariants({ variant: "secondary" });
    expect(cls).toContain("bg-secondary");
    expect(cls).toContain("text-secondary-foreground");
  });

  it("applies ghost variant classes", () => {
    const cls = buttonVariants({ variant: "ghost" });
    expect(cls).toContain("hover:bg-accent");
  });

  it("applies destructive variant classes", () => {
    const cls = buttonVariants({ variant: "destructive" });
    expect(cls).toContain("bg-destructive");
  });

  it("applies link variant classes", () => {
    const cls = buttonVariants({ variant: "link" });
    expect(cls).toContain("underline-offset-4");
  });

  it("applies destructive-outline variant classes", () => {
    const cls = buttonVariants({ variant: "destructive-outline" });
    expect(cls).toContain("text-destructive");
    expect(cls).toContain("border-destructive/50");
  });

  it("applies the compact coss default size (32px / h-8)", () => {
    const cls = buttonVariants({ size: "default" });
    expect(cls).toContain("h-8");
  });

  it("applies xs size classes", () => {
    const cls = buttonVariants({ size: "xs" });
    expect(cls).toContain("h-6");
    expect(cls).toContain("text-xs");
  });

  it("applies sm size classes", () => {
    const cls = buttonVariants({ size: "sm" });
    expect(cls).toContain("h-7");
    expect(cls).toContain("text-xs");
  });

  it("applies lg size classes", () => {
    const cls = buttonVariants({ size: "lg" });
    expect(cls).toContain("h-9");
    expect(cls).toContain("px-6");
  });

  it("applies xl size classes", () => {
    const cls = buttonVariants({ size: "xl" });
    expect(cls).toContain("h-10");
    expect(cls).toContain("px-8");
  });

  it("applies icon size classes", () => {
    const cls = buttonVariants({ size: "icon" });
    expect(cls).toContain("size-8");
  });

  it("applies icon-sm and icon-lg size classes", () => {
    expect(buttonVariants({ size: "icon-sm" })).toContain("size-7");
    expect(buttonVariants({ size: "icon-lg" })).toContain("size-9");
  });

  it("merges a custom className without losing variant classes", () => {
    const cls = buttonVariants({ className: "my-custom-class" });
    expect(cls).toContain("my-custom-class");
    expect(cls).toContain("bg-primary");
  });
});
