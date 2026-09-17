// The root layout owns the title template: a page returns its pages.* title and
// the tab reads "<title> · Oxagen"; a route with no title of its own reads the
// product name (ARCHITECTURE.md §1.2). It also owns metadataBase, the origin
// every relative social-image URL resolves against (#3091).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

const { generateMetadata } = await import("./layout");

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("root layout metadata", () => {
  it("templates every page title with the product name and defaults to it", async () => {
    const { title } = await generateMetadata();
    expect(title).toEqual({ default: "Oxagen", template: "%s · Oxagen" });
  });

  it("resolves the social image against NEXT_PUBLIC_APP_URL, not localhost", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.oxagen.sh";
    const { metadataBase, openGraph, twitter } = await generateMetadata();
    expect(String(metadataBase)).toBe("https://app.oxagen.sh/");
    const [image] = openGraph?.images as [{ url: string }];
    expect(new URL(image.url, String(metadataBase)).href).toBe(
      "https://app.oxagen.sh/social/og-image-dark-1200x630.png",
    );
    expect(twitter?.images).toEqual(["/social/og-image-dark-1200x630.png"]);
  });

  it("does not advertise localhost when the origin is unset (negative)", async () => {
    const { metadataBase } = await generateMetadata();
    expect(String(metadataBase)).toBe("https://app.oxagen.sh/");
  });
});
