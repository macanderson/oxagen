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
  // `NODE_ENV` decides the fallback origin, so a shell that exports
  // `development` (every `next dev` terminal) would otherwise flip the
  // production cases to localhost. Pin it; the one development case
  // stubs over this.
  vi.stubEnv("NODE_ENV", "test");
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
    const social = "/social/og-image-dark-1200x630.png";
    expect(String(metadataBase)).toBe("https://app.oxagen.sh/");
    // The card declares the path relative; the base is what makes it absolute,
    // so both halves are asserted — a base with nothing to resolve, or a card
    // with no base, each fails one of them.
    expect(JSON.stringify(openGraph?.images)).toContain(social);
    expect(twitter?.images).toEqual([social]);
    expect(new URL(social, String(metadataBase)).href).toBe(
      `https://app.oxagen.sh${social}`,
    );
  });

  it("does not advertise localhost when the origin is unset (negative)", async () => {
    const { metadataBase } = await generateMetadata();
    expect(String(metadataBase)).toBe("https://app.oxagen.sh/");
  });
});
