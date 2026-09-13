import { describe, it, expect, afterEach, vi } from "vitest";
import { chatUxV2Enabled, CHAT_UX_V2_COOKIE } from "./flags";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chatUxV2Enabled", () => {
  it("defaults off with no env and no cookie", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_UX_V2", "");
    expect(chatUxV2Enabled()).toBe(false);
    expect(chatUxV2Enabled(null)).toBe(false);
    expect(chatUxV2Enabled(undefined)).toBe(false);
  });

  it("cookie override wins in both directions", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_UX_V2", "");
    expect(chatUxV2Enabled("1")).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_CHAT_UX_V2", "1");
    expect(chatUxV2Enabled("0")).toBe(false);
  });

  it("env default enables when no cookie is set", () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_UX_V2", "1");
    expect(chatUxV2Enabled()).toBe(true);
    expect(chatUxV2Enabled("garbage")).toBe(true);
  });

  it("exports the cookie name proxy.ts persists", () => {
    expect(CHAT_UX_V2_COOKIE).toBe("chat_ux_v2");
  });
});
