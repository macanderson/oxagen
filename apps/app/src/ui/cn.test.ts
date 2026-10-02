// The app's cn() is the shared helper from @oxagen/ui. These cases prove the
// app gets the house type fix (#5185); packages/ui/src/lib/utils.test.ts runs
// every step of both scales.
import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("lets a later class win over an earlier one for the same property", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("keeps a house type size beside a text colour", () => {
    expect(cn("text-a-h3", "text-foreground")).toBe("text-a-h3 text-foreground");
    expect(cn("text-m-body text-app-panel-fg")).toBe("text-m-body text-app-panel-fg");
  });

  it("lets a later house size override an earlier one", () => {
    expect(cn("text-a-h3 text-foreground", "text-a-h1")).toBe("text-foreground text-a-h1");
  });
});
