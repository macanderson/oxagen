// The root layout owns the title template: a page returns its pages.* title and
// the tab reads "<title> · Oxagen"; a route with no title of its own reads the
// product name (ARCHITECTURE.md §1.2).
import { describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

const { generateMetadata } = await import("./layout");

describe("root layout metadata", () => {
  it("templates every page title with the product name and defaults to it", async () => {
    const { title } = await generateMetadata();
    expect(title).toEqual({ default: "Oxagen", template: "%s · Oxagen" });
  });
});
