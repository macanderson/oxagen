import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { loadCatalogs } from "./load-catalogs";

// getRequestConfig only wraps the factory; unwrap it so the factory runs here.
vi.mock("next-intl/server", () => ({
  getRequestConfig: <T>(factory: T) => factory,
}));

type Factory = () => { locale: string; messages: Record<string, unknown> };

const messagesDir = path.join(process.cwd(), "messages");

describe("i18n request config", () => {
  it("serves English with every catalog under messages/ merged", async () => {
    const { default: factory } = await import("./request");
    const config = (factory as unknown as Factory)();

    expect(config.locale).toBe("en");
    expect(config.messages).toEqual(loadCatalogs(messagesDir));
    // en.json is always part of the merge, whatever page catalogs exist.
    expect(config.messages).toMatchObject(en);
  });

  it("reads the directory once per process outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: factory } = await import("./request");
    const f = factory as unknown as Factory;

    expect(f().messages).toBe(f().messages);
  });

  it("re-reads the directory in development so a new catalog shows on refresh", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { default: factory } = await import("./request");
    const f = factory as unknown as Factory;

    const first = f().messages;
    const second = f().messages;
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
