import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requestAuth } from "./request-auth";

const ORIGIN = "http://127.0.0.1:7799";
const TOKEN = "a".repeat(64);

function server() {
  const reached = vi.fn();
  const app = new Hono();
  app.use("*", requestAuth(ORIGIN, TOKEN));
  app.all("*", (c) => {
    reached();
    return c.json({ ok: true });
  });
  return {
    reached,
    request: (
      path: string,
      headers: Record<string, string> = {},
      method = "GET",
    ) =>
      app.request(`${ORIGIN}${path}`, {
        method,
        headers: { host: "127.0.0.1:7799", ...headers },
      }),
  };
}

describe("local request authorization", () => {
  it.each(["/api/secrets", "/api/catalog", "/api/state", "/api/gaps", "/api"])(
    "requires a token before reading %s",
    async (path) => {
      const { reached, request } = server();
      expect((await request(path)).status).toBe(401);
      expect(reached).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "PATCH", "DELETE", "OPTIONS"])(
    "refuses unauthenticated %s before any side effect",
    async (method) => {
      const { reached, request } = server();
      expect((await request("/api/secrets/key", {}, method)).status).toBe(401);
      expect(reached).not.toHaveBeenCalled();
    },
  );

  it.each(["Bearer wrong", `Bearer ${"b".repeat(64)}`, TOKEN])(
    "refuses an invalid or previous-process token",
    async (authorization) => {
      const { reached, request } = server();
      expect((await request("/api/secrets", { authorization })).status).toBe(
        401,
      );
      expect(reached).not.toHaveBeenCalled();
    },
  );

  it.each([
    { host: "attacker.test:7799" },
    { host: "127.0.0.1:7800" },
    { host: "127.0.0.1.attacker.test:7799" },
    { origin: "https://attacker.test" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ] as Record<string, string>[])(
    "rejects rebinding and cross-origin requests even with a token: %j",
    async (headers) => {
      const { reached, request } = server();
      expect(
        (
          await request("/api/secrets", {
            authorization: `Bearer ${TOKEN}`,
            ...headers,
          })
        ).status,
      ).toBe(403);
      expect(reached).not.toHaveBeenCalled();
    },
  );

  it("rejects a different URL origin even when Host matches", async () => {
    const reached = vi.fn();
    const app = new Hono();
    app.use("*", requestAuth(ORIGIN, TOKEN));
    app.get("/api/secrets", (c) => {
      reached();
      return c.text("secret");
    });
    const response = await app.request(
      "http://attacker.test:7799/api/secrets",
      {
        headers: { host: "127.0.0.1:7799", authorization: `Bearer ${TOKEN}` },
      },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(reached).not.toHaveBeenCalled();
  });

  it("accepts the local page and authenticated API without caching credentials", async () => {
    const { request } = server();
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(
      (
        await request(
          "/api/set",
          {
            authorization: `Bearer ${TOKEN}`,
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
          },
          "POST",
        )
      ).status,
    ).toBe(200);
  });
});

function browser(hash = `#token=${TOKEN}`, stored?: string) {
  const values = new Map(stored ? [["oxagen.env-manager.access", stored]] : []);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const fetch = vi.fn().mockResolvedValue(new Response("{}"));
  const notice = { hidden: true, textContent: "" };
  const replaceState = vi.fn();
  const window = {} as {
    envManagerFetch: (path: string, init?: RequestInit) => Promise<Response>;
  };
  runInNewContext(
    readFileSync(new URL("../public/request.js", import.meta.url), "utf8"),
    {
      window,
      location: {
        hash,
        pathname: "/",
        search: "",
        href: `${ORIGIN}/${hash}`,
        origin: ORIGIN,
      },
      history: { replaceState },
      sessionStorage: storage,
      URL,
      URLSearchParams,
      Headers,
      fetch,
      document: { getElementById: () => notice },
    },
  );
  return { window, fetch, values, notice, replaceState };
}

describe("browser access bootstrap", () => {
  it("removes the fragment and authenticates reads and writes", async () => {
    const { window, fetch, replaceState, values } = browser();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(values.get("oxagen.env-manager.access")).toBe(TOKEN);
    await window.envManagerFetch("/api/secrets", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.hash).toBe("");
    expect((init.headers as Headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect((init.headers as Headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init).toMatchObject({
      method: "PATCH",
      cache: "no-store",
      redirect: "error",
      body: "{}",
    });
  });

  it("keeps tab access during page navigation", async () => {
    const { window, fetch } = browser("", TOKEN);
    await window.envManagerFetch("/api/catalog");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["", "#token=invalid"])(
    "shows the access instruction without making a request: %s",
    async (hash) => {
      const { window, fetch, notice } = browser(hash);
      await expect(window.envManagerFetch("/api/secrets")).rejects.toThrow(
        "current access link",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(notice.hidden).toBe(false);
    },
  );

  it("does not forward credentials to another origin or a non-API route", async () => {
    const { window, fetch } = browser();
    await expect(
      window.envManagerFetch("https://attacker.test/api/secrets"),
    ).rejects.toThrow("Only local");
    await expect(window.envManagerFetch("/secrets")).rejects.toThrow(
      "Only local",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears expired access and requires the new process link", async () => {
    const { window, fetch, notice, values } = browser();
    fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(window.envManagerFetch("/api/secrets")).rejects.toThrow(
      "expired",
    );
    expect(values.size).toBe(0);
    expect(notice.hidden).toBe(false);
  });
});
