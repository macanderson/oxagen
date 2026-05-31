// button.test.tsx — unit tests for Button variant map and buttonVariants().
//
// These tests exercise the cva() variant map directly via buttonVariants() so
// they run without a DOM renderer. Full render tests (asChild forwarding,
// event handlers) require @testing-library/react to be added as a devDependency
// — tracked separately.

import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button.js";

describe("buttonVariants", () => {
  it("includes the base classes for the default variant", () => {
    const cls = buttonVariants({});
    expect(cls).toContain("inline-flex");
    expect(cls).toContain("items-center");
    expect(cls).toContain("rounded-xl");
  });

  it("applies the default variant classes when no variant is specified", () => {
    const cls = buttonVariants({});
    expect(cls).toContain("bg-accent");
    expect(cls).toContain("text-accent-foreground");
  });

  it("applies outline variant classes", () => {
    const cls = buttonVariants({ variant: "outline" });
    expect(cls).toContain("border");
    expect(cls).toContain("backdrop-blur");
  });

  it("applies ghost variant classes", () => {
    const cls = buttonVariants({ variant: "ghost" });
    expect(cls).toContain("hover:bg-muted");
  });

  it("applies glass variant classes", () => {
    const cls = buttonVariants({ variant: "glass" });
    expect(cls).toContain("glass");
  });

  it("applies destructive variant classes", () => {
    const cls = buttonVariants({ variant: "destructive" });
    expect(cls).toContain("bg-destructive");
  });

  it("applies link variant classes", () => {
    const cls = buttonVariants({ variant: "link" });
    expect(cls).toContain("underline-offset-4");
  });

  it("applies sm size classes", () => {
    const cls = buttonVariants({ size: "sm" });
    expect(cls).toContain("h-8");
    expect(cls).toContain("text-xs");
  });

  it("applies lg size classes", () => {
    const cls = buttonVariants({ size: "lg" });
    expect(cls).toContain("h-12");
    expect(cls).toContain("rounded-2xl");
  });

  it("applies icon size classes", () => {
    const cls = buttonVariants({ size: "icon" });
    expect(cls).toContain("h-10");
    expect(cls).toContain("w-10");
  });

  it("merges a custom className without losing variant classes", () => {
    const cls = buttonVariants({ className: "my-custom-class" });
    expect(cls).toContain("my-custom-class");
    expect(cls).toContain("bg-accent");
  });
});
