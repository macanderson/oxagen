import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requestBaseUrl } from "./base-url";
import type { AppEnv } from "../../app";

async function resolve(headers: Record<string, string>): Promise<string> {
  const app = new Hono<AppEnv>();
  let captured = "";
  app.get("/x", (c) => {
    captured = requestBaseUrl(c);
    return c.text("ok");
  });
  await app.request("/x", { headers });
  return captured;
}

describe("requestBaseUrl", () => {
  it("prefers x-forwarded-proto + x-forwarded-host", async () => {
    expect(
      await resolve({
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.oxagen.sh",
        host: "internal:4000",
      }),
    ).toBe("https://api.oxagen.sh");
  });

  it("falls back to the Host header with https", async () => {
    expect(await resolve({ host: "api.example.test" })).toBe(
      "https://api.example.test",
    );
  });
});
