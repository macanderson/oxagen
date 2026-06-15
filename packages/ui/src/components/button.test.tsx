// button.test.tsx — unit tests for Button variant map and buttonVariants().
//
// These tests exercise the cva() variant map directly via buttonVariants() so
// they run without a DOM renderer. Full render tests (Base UI `render`
// forwarding, event handlers) require @testing-library/react to be added as a
// devDependency — tracked separately.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, buttonVariants } from "./button";

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

  it("applies gradient variant classes (brand nebula fill + violet glow)", () => {
    const cls = buttonVariants({ variant: "gradient" });
    expect(cls).toContain("brand-gradient");
    expect(cls).toContain("text-white");
    expect(cls).toContain("hover:[box-shadow:var(--glow-violet)]");
  });

  it("composes the gradient variant with sizes", () => {
    const cls = buttonVariants({ variant: "gradient", size: "lg" });
    expect(cls).toContain("brand-gradient");
    expect(cls).toContain("h-9");
    expect(cls).toContain("px-6");
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

// startIcon/endIcon render composition. Exercised through SSR (renderToStaticMarkup)
// so we verify the actual DOM order Base UI's `useRender` produces — no
// @testing-library/react needed and it stays in the node test environment.
describe("Button startIcon / endIcon", () => {
  it("renders nothing extra when no icons are passed", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toContain("Save");
    expect(html).not.toContain("data-icon");
  });

  it("renders startIcon before the label", () => {
    const html = renderToStaticMarkup(
      <Button startIcon={<span data-icon="start">→</span>}>Run agent</Button>,
    );
    const iconAt = html.indexOf('data-icon="start"');
    const labelAt = html.indexOf("Run agent");
    expect(iconAt).toBeGreaterThanOrEqual(0);
    expect(labelAt).toBeGreaterThan(iconAt);
  });

  it("renders endIcon after the label", () => {
    const html = renderToStaticMarkup(
      <Button endIcon={<span data-icon="end">↗</span>}>Open</Button>,
    );
    const labelAt = html.indexOf("Open");
    const iconAt = html.indexOf('data-icon="end"');
    expect(labelAt).toBeGreaterThanOrEqual(0);
    expect(iconAt).toBeGreaterThan(labelAt);
  });

  it("brackets the label with both icons in order", () => {
    const html = renderToStaticMarkup(
      <Button
        startIcon={<span data-icon="start" />}
        endIcon={<span data-icon="end" />}
      >
        Deploy
      </Button>,
    );
    const startAt = html.indexOf('data-icon="start"');
    const labelAt = html.indexOf("Deploy");
    const endAt = html.indexOf('data-icon="end"');
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(labelAt).toBeGreaterThan(startAt);
    expect(endAt).toBeGreaterThan(labelAt);
  });

  it("forwards icons onto a custom `render` target (e.g. an anchor)", () => {
    const html = renderToStaticMarkup(
      <Button
        variant="gradient"
        render={<a href="/run" />}
        startIcon={<span data-icon="start" />}
      >
        Run
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/run"');
    expect(html).toContain('data-icon="start"');
    expect(html).toContain("brand-gradient");
  });
});
