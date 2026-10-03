// @vitest-environment jsdom
// shadcn's maia button on the house tokens (ADR-221): a pill in every
// variant, the gold only on `default`, the caller's class winning over the
// component's, and no `primary` token anywhere (INV-32).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { Button } from "./button";
import { cn } from "./cn";

const INK_PRIMARY =
  /\b(bg|text|border|ring|shadow-\[inset[^\]]*)-primary\b|var\(--primary\)/;

describe("Button", () => {
  it("draws the maia pill with the gold action by default", async () => {
    const { container } = render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button.className).toContain("rounded-4xl");
    expect(button.className).toContain("h-9");
    expect(button.className).toContain("bg-button-primary-bg");
    await expectNoAxe(container);
  });

  it("keeps the gold off every other variant and `primary` off all of them", () => {
    for (const variant of [
      "outline",
      "secondary",
      "ghost",
      "destructive",
      "link",
    ] as const) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      const button = screen.getByRole("button", { name: variant });
      expect(button.className).not.toMatch(/button-primary|gold/);
      expect(button.className).not.toMatch(INK_PRIMARY);
      unmount();
    }
    render(<Button>gold</Button>);
    expect(screen.getByRole("button", { name: "gold" }).className).not.toMatch(
      INK_PRIMARY,
    );
  });

  it("sizes an icon button square and lets the caller's class win", () => {
    render(
      <Button variant="ghost" size="icon-sm" aria-label="Close" className="size-6">
        x
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Close" });
    expect(button.className).toContain("size-6");
    expect(button.className).not.toContain("size-8");
  });

  it("disables through Base UI, so a pointer cannot press it", () => {
    render(<Button disabled>Wait</Button>);
    expect(screen.getByRole("button", { name: "Wait" })).toBeDisabled();
  });
});

describe("cn", () => {
  it("drops falsy parts and lets a later class win over one on the same property", () => {
    expect(cn("px-3", false, undefined, "px-4")).toBe("px-4");
    expect(cn("text-base text-muted-foreground", "text-foreground")).toBe(
      "text-base text-foreground",
    );
  });
});
