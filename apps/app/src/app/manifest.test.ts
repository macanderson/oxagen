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

  it("includes the full icon ladder plus maskable variants", () => {
    const sizes = result.icons?.map((icon) => icon.sizes);
    expect(sizes).toEqual([
      "72x72",
      "96x96",
      "128x128",
      "144x144",
      "152x152",
      "192x192",
      "256x256",
      "384x384",
      "512x512",
      "192x192",
      "512x512",
    ]);
    const maskable = result.icons?.filter(
      (icon) => icon.purpose === "maskable",
    );
    expect(maskable).toHaveLength(2);
    const any = result.icons?.filter((icon) => icon.purpose === "any");
    expect(any).toHaveLength(9);
  });
});
