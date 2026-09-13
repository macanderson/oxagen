// The live-data SSE route (plan §4.9) and the membership gate it shares with
// every page (requireViewer), driven against the fixture data source.
//
// Fixture tenancy (src/server/fixture-tenancy.ts): the fixture operator belongs
// to acme / core-platform, not to acme / finops; acme-robotics and platform are
// historical slugs. Until a data source provides feeds, the route streams the
// honest not-backed state for each (G6 frames, G3 fleet).
import { expect, test } from "./support";

const stream = "/api/mc/acme/core-platform/stream";

test.describe("mc stream route", () => {
  test("a signed-out request never reaches the stream", async ({
    playwright,
    baseURL,
  }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const res = await anon.get(`${stream}?run=arun_01`, { maxRedirects: 0 });
    expect([302, 307, 401]).toContain(res.status());
    if (res.status() !== 401)
      expect(res.headers().location).toContain("/login");
    await anon.dispose();
  });

  test("streams a run's frames as SSE, ending in the not-backed state", async ({
    signedInPage: page,
  }) => {
    const res = await page.request.get(`${stream}?run=arun_01&after=0`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    expect(res.headers()["cache-control"]).toContain("no-store");
    const body = await res.text();
    expect(body).toContain("retry: 3000");
    expect(body).toContain("event: state");
    expect(body).toContain('"reason":"not_backed"');
    expect(body).toContain('"gap":"G6"');
  });

  test("streams fleet patches when no run is named", async ({
    signedInPage: page,
  }) => {
    const res = await page.request.get(stream);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('"gap":"G3"');
  });

  test("refuses a malformed cursor and run id", async ({
    signedInPage: page,
  }) => {
    const badAfter = await page.request.get(`${stream}?run=arun_01&after=-1`);
    expect(badAfter.status()).toBe(400);
    expect(await badAfter.json()).toEqual({ code: "invalid_stream_cursor" });

    const badLastEventId = await page.request.get(`${stream}?run=arun_01`, {
      headers: { "Last-Event-ID": "1 OR 1=1" },
    });
    expect(badLastEventId.status()).toBe(400);

    const badRun = await page.request.get(`${stream}?run=..%2Fsecrets`);
    expect(badRun.status()).toBe(400);
    expect(await badRun.json()).toEqual({ code: "invalid_run_id" });
  });

  test("404s an unknown organization and a workspace the viewer is not a member of", async ({
    signedInPage: page,
  }) => {
    for (const path of [
      "/api/mc/globex/core-platform/stream",
      "/api/mc/acme/finops/stream",
      "/api/mc/acme/no-such-workspace/stream",
    ]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
      expect(await res.json()).toEqual({ code: "not_found" });
    }
  });

  test("308s a renamed organization and workspace to the canonical stream", async ({
    signedInPage: page,
  }) => {
    const res = await page.request.get(
      "/api/mc/acme-robotics/platform/stream?run=arun_01&after=3",
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(308);
    expect(res.headers().location).toBe(
      "/api/mc/acme/core-platform/stream?run=arun_01&after=3",
    );
  });
});
