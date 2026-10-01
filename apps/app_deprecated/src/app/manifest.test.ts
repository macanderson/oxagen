import { HOUSE_INK } from "@oxagen/ui/lib/house-grounds";
import { describe, expect, it } from "vitest";

import manifest from "./manifest";

describe("app manifest route", () => {
  const result = manifest();

  it("declares the standalone PWA shell identity", () => {
    expect(result.id).toBe("/");
    expect(result.name).toBe("Oxagen");
    expect(result.display).toBe("standalone");
    expect(result.start_url).toBe("/");
    expect(result.scope).toBe("/");
  });

  it("lists the sizes the brand kit ships, plus the maskable pair", () => {
    const sizes = result.icons?.map((icon) => icon.sizes);
    expect(sizes).toEqual(["192x192", "512x512", "192x192", "512x512"]);
    const maskable = result.icons?.filter(
      (icon) => icon.purpose === "maskable",
    );
    expect(maskable).toHaveLength(2);
    const any = result.icons?.filter((icon) => icon.purpose === "any");
    expect(any).toHaveLength(2);
  });

  it("takes its grounds from the brand kit", () => {
    expect(result.theme_color).toBe(HOUSE_INK);
    expect(result.background_color).toBe(HOUSE_INK);
  });
});
