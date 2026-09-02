/**
 * Unit tests for the CORS allowlist, especially the marketing-origin apex↔www
 * twinning: the marketing site answers on both oxagen.sh and www.oxagen.sh, so
 * a single configured MARKETING_URL must admit both browser origins. The app
 * origin is a single canonical host and must NOT be twinned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const runtime = vi.hoisted(() => ({ production: true }));

vi.mock("@oxagen/config/env", () => ({
  isProductionRuntime: () => runtime.production,
}));

import { corsMiddleware } from "./cors";

const ENV_KEYS = ["APP_URL", "NEXT_PUBLIC_APP_URL", "MARKETING_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  runtime.production = true;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function preflight(origin: string): Promise<string | null> {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.post("/x", (c) => c.json({ ok: true }));
  const res = await app.request(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
      },
    }),
  );
  return res.headers.get("access-control-allow-origin");
}

describe("corsMiddleware marketing-origin twinning", () => {
  it("allows the www twin when MARKETING_URL is the apex", async () => {
    process.env.MARKETING_URL = "https://oxagen.sh";
    expect(await preflight("https://oxagen.sh")).toBe("https://oxagen.sh");
    expect(await preflight("https://www.oxagen.sh")).toBe(
      "https://www.oxagen.sh",
    );
  });

  it("allows the apex twin when MARKETING_URL is the www host", async () => {
    process.env.MARKETING_URL = "https://www.oxagen.sh";
    expect(await preflight("https://www.oxagen.sh")).toBe(
      "https://www.oxagen.sh",
    );
    expect(await preflight("https://oxagen.sh")).toBe("https://oxagen.sh");
  });

  it("tolerates a trailing slash on MARKETING_URL", async () => {
    process.env.MARKETING_URL = "https://www.oxagen.sh/";
    expect(await preflight("https://oxagen.sh")).toBe("https://oxagen.sh");
  });

  it("rejects unrelated origins", async () => {
    process.env.MARKETING_URL = "https://oxagen.sh";
    expect(await preflight("https://evil.example.com")).toBeNull();
  });

  it("does NOT twin the app origin", async () => {
    process.env.APP_URL = "https://app.oxagen.sh";
    expect(await preflight("https://app.oxagen.sh")).toBe(
      "https://app.oxagen.sh",
    );
    expect(await preflight("https://www.app.oxagen.sh")).toBeNull();
  });

  it("rejects localhost in production but allows it outside production", async () => {
    expect(await preflight("http://localhost:8080")).toBeNull();
    runtime.production = false;
    expect(await preflight("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });
});
