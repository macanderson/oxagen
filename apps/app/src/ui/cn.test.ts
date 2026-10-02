// The app's class merger. A house type utility such as `text-a-h3` sets a font
// size, and tailwind-merge's default config read it as a text colour, so a
// colour class beside it dropped the size (#5185). The full case list for the
// shared config lives in packages/ui/src/lib/utils.test.ts.
import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("lets a later class win over an earlier one for the same property", () => {
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });

  it.each(["text-a-h1", "text-a-h3", "text-a-body", "text-m-h1", "text-m-body"])(
    "keeps %s beside a text colour",
    (size) => {
      expect(cn(size, "text-app-panel-fg")).toBe(`${size} text-app-panel-fg`);
      expect(cn("text-app-panel-fg", size)).toBe(`text-app-panel-fg ${size}`);
    },
  );

  it("lets a later size override a house size", () => {
    expect(cn("text-a-h3", "text-sm")).toBe("text-sm");
    expect(cn("text-a-h3", "text-a-h1")).toBe("text-a-h1");
  });
});
