// @vitest-environment jsdom
/**
 * button.test.tsx — unit tests for the Button variant map and buttonVariants(),
 * SSR icon composition tests, and jsdom render tests.
 *
 * Color/state assertions target the --button-* token utilities (THEME.md §5):
 * the variants must NOT reference the core --primary/--accent directly, and must
 * NOT use the phantom `bg-button-primary` / `text-button-primary-foreground`
 * names (which generate no CSS — the tokens are `--button-primary-bg` / `-fg`).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { Button, buttonVariants } from "./button";

afterEach(cleanup);

describe("buttonVariants", () => {
  it("includes the base classes for the default variant", () => {
    const cls = buttonVariants({});
    expect(cls).toContain("inline-flex");
    expect(cls).toContain("items-center");
    expect(cls).toContain("rounded-md");
  });

  it("applies the default (primary) variant token classes when no variant is specified", () => {
    const cls = buttonVariants({});
    expect(cls).toContain("bg-button-primary-bg");
    expect(cls).toContain("text-button-primary-fg");
    // Must use the real token utilities, never the phantom names.
    expect(cls).not.toContain("bg-button-primary ");
    expect(cls).not.toContain("text-button-primary-foreground");
  });

  it("wires the primary border, focus ring, and disabled tokens", () => {
    const cls = buttonVariants({ variant: "primary" });
    expect(cls).toContain("border-button-primary-border");
    expect(cls).toContain("focus-visible:ring-button-primary-ring");
    expect(cls).toContain("disabled:bg-button-disabled-bg");
    expect(cls).toContain("disabled:text-button-disabled-fg");
  });

  it("applies outline variant default-token classes", () => {
    const cls = buttonVariants({ variant: "outline" });
    expect(cls).toContain("border");
    expect(cls).toContain("border-button-default-border");
    expect(cls).toContain("bg-button-default-bg");
    expect(cls).toContain("text-button-default-fg");
    expect(cls).toContain("focus-visible:ring-button-default-ring");
  });

  it("applies secondary variant classes", () => {
    const cls = buttonVariants({ variant: "secondary" });
    expect(cls).toContain("bg-secondary");
    expect(cls).toContain("text-secondary-foreground");
    expect(cls).toContain("hover:bg-button-default-hover-bg");
  });

  it("applies ghost variant default-hover token", () => {
    const cls = buttonVariants({ variant: "ghost" });
    expect(cls).toContain("hover:bg-button-default-hover-bg");
    expect(cls).toContain("text-button-default-fg");
  });

  it("applies destructive variant classes", () => {
    const cls = buttonVariants({ variant: "destructive" });
    expect(cls).toContain("bg-error");
    expect(cls).toContain("focus-visible:ring-error");
  });

  it("applies link variant classes", () => {
    const cls = buttonVariants({ variant: "link" });
    expect(cls).toContain("underline-offset-4");
  });

  it("applies destructive-outline variant classes", () => {
    const cls = buttonVariants({ variant: "destructive-outline" });
    expect(cls).toContain("text-error");
    expect(cls).toContain("border-error/50");
  });

  it("treats gradient as a flat primary alias (FLAT policy — no gradient/glow fill)", () => {
    const cls = buttonVariants({ variant: "gradient" });
    expect(cls).toContain("bg-button-primary-bg");
    expect(cls).toContain("text-button-primary-fg");
    // The flat reskin removed the decorative gradient + violet glow.
    expect(cls).not.toContain("brand-gradient");
    expect(cls).not.toContain("glow-violet");
  });

  it("composes the gradient variant with sizes", () => {
    const cls = buttonVariants({ variant: "gradient", size: "lg" });
    expect(cls).toContain("bg-button-primary-bg");
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
    expect(cls).toContain("bg-button-primary-bg");
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
    expect(html).toContain("bg-button-primary-bg");
  });
});

// ── jsdom render tests (merged from apps/app) ────────────────────────────────

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
    expect(getByRole("button", { name: "Outline" }).className).toContain(
      "border-button-default-border",
    );
  });

  it("applies size class to the rendered button", () => {
    const { getByRole } = render(<Button size="lg">Large</Button>);
    expect(getByRole("button", { name: "Large" }).className).toContain("h-9");
  });

  it("merges extra className", () => {
    const { getByRole } = render(<Button className="extra-cls">Btn</Button>);
    expect(getByRole("button", { name: "Btn" }).className).toContain(
      "extra-cls",
    );
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
      <Button render={<a href="/test" />}>Link Button</Button>,
    );
    const anchor = getByRole("link", { name: "Link Button" });
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute("href", "/test");
    expect(anchor).toHaveTextContent("Link Button");
    expect(anchor.className).toContain("bg-button-primary-bg");
  });

  it("type defaults to button (not submit) to prevent accidental form submission", () => {
    const { getByRole } = render(<Button>Safe</Button>);
    expect(getByRole("button", { name: "Safe" })).toHaveAttribute(
      "type",
      "button",
    );
  });

  it("wraps a disabled button in a focusable tooltip anchor when disabledTooltip is set", () => {
    const { getByRole } = render(
      <Button disabled disabledTooltip="You need the Editor role.">
        Publish
      </Button>,
    );
    const btn = getByRole("button", { name: "Publish" });
    expect(btn).toBeDisabled();
    // A disabled <button> emits no pointer events, so it is wrapped in a
    // focusable span that anchors the tooltip (hover/focus lands on the span).
    const anchor = btn.closest("[data-base-ui-tooltip-trigger]");
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute("tabindex", "0");
  });

  it("does not wrap when enabled, even if disabledTooltip is provided", () => {
    const { getByRole } = render(
      <Button disabledTooltip="You need the Editor role.">Publish</Button>,
    );
    const btn = getByRole("button", { name: "Publish" });
    expect(btn).not.toBeDisabled();
    expect(btn.closest("[data-base-ui-tooltip-trigger]")).toBeNull();
  });

  it("does not wrap a disabled button that has no disabledTooltip", () => {
    const { getByRole } = render(<Button disabled>Off</Button>);
    const btn = getByRole("button", { name: "Off" });
    expect(btn.closest("[data-base-ui-tooltip-trigger]")).toBeNull();
  });
});

describe("Button — loading state", () => {
  it("shows a spinner, disables the button, and sets aria-busy", () => {
    const { getByRole } = render(<Button loading>Save</Button>);
    const btn = getByRole("button", { name: /Save/ });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.querySelector(".animate-spin")).not.toBeNull();
  });

  it("keeps the label visible while loading", () => {
    const { getByText } = render(<Button loading>Save</Button>);
    expect(getByText("Save")).toBeInTheDocument();
  });

  it("replaces startIcon with the spinner while loading", () => {
    const { getByRole, rerender } = render(
      <Button startIcon={<svg data-testid="start" />}>Go</Button>,
    );
    expect(
      getByRole("button").querySelector("[data-testid=start]"),
    ).not.toBeNull();
    rerender(
      <Button loading startIcon={<svg data-testid="start" />}>
        Go
      </Button>,
    );
    const btn = getByRole("button");
    expect(btn.querySelector("[data-testid=start]")).toBeNull();
    expect(btn.querySelector(".animate-spin")).not.toBeNull();
  });

  it("does not fire onClick while loading", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { getByRole } = render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    await user.click(getByRole("button", { name: /Save/ })).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
  });

  it("no aria-busy or spinner at rest", () => {
    const { getByRole } = render(<Button>Save</Button>);
    const btn = getByRole("button");
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.querySelector(".animate-spin")).toBeNull();
  });
});
