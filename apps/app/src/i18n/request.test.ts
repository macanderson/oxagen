import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";

// getRequestConfig only wraps the factory; unwrap it so the factory runs here.
vi.mock("next-intl/server", () => ({
  getRequestConfig: <T>(factory: T) => factory,
}));

describe("i18n request config", () => {
  it("serves English with every catalog merged", async () => {
    const { default: factory } = await import("./request");
    const config = await (
      factory as unknown as () => Promise<{ locale: string; messages: unknown }>
    )();
    expect(config.locale).toBe("en");
    expect(config.messages).toEqual(en);
  });
});
