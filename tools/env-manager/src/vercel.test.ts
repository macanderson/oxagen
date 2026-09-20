import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertEnv } from "./vercel";
import type { Config } from "./config";

const cfg: Config = {
  vercelToken: "test-token",
  teamId: "team-1",
  port: 7799,
  projects: {
    api: "api",
    app: "app",
    mcp: "mcp",
    website: "web",
    admin: "admin",
    docs: "docs",
  },
};
afterEach(() => vi.unstubAllGlobals());

describe("remote environment replacement", () => {
  it("updates only the requested target through one upsert, without deleting it first", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ created: { id: "env-1" }, failed: [] }),
      );
    vi.stubGlobal("fetch", fetch);
    await upsertEnv(cfg, "prj-1", "SECRET", "new-value", "production", true);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("upsert")).toBe("true");
    expect(new URL(url).searchParams.get("teamId")).toBe("team-1");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      key: "SECRET",
      value: "new-value",
      type: "encrypted",
      target: ["production"],
    });
  });

  it("leaves existing state alone when the update fails, without exposing provider text", async () => {
    const calls: string[] = [];
    let existing = "old-value";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init.method ?? "GET");
        if (init.method === "GET")
          return Response.json({
            envs: [{ id: "env-1", key: "SECRET", target: ["production"] }],
          });
        if (init.method === "DELETE") {
          existing = "";
          return new Response(null, { status: 204 });
        }
        return new Response("provider echoed new-value", { status: 503 });
      }),
    );
    await expect(
      upsertEnv(cfg, "prj-1", "SECRET", "new-value", "production", true),
    ).rejects.toThrow("HTTP 503");
    expect(calls).toEqual(["POST"]);
    expect(existing).toBe("old-value");
  });

  it("treats a provider refusal inside a successful HTTP response as a failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ failed: [{ error: { value: "new-value" } }] }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      upsertEnv(cfg, "prj-1", "SECRET", "new-value", "preview", true),
    ).rejects.toThrow("provider refused");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not expose provider content when JSON decoding fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("submitted-secret is not JSON")),
    );
    await expect(
      upsertEnv(cfg, "prj-1", "SECRET", "submitted-secret", "production", true),
    ).rejects.toThrow(/^upsert SECRET\/production: invalid provider response$/);
  });

  it("does not try destructive recovery after a transport failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("network unavailable"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      upsertEnv(cfg, "prj-1", "PUBLIC", "v", "development", false),
    ).rejects.toThrow("network unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
