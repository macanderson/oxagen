// The live-data SSE route (plan §4.9) and the membership gate it shares with
// every page (requireViewer), driven against the fixture data source.
//
// Fixture tenancy (src/server/fixture-tenancy.ts): the fixture operator belongs
// to acme / core-platform, not to acme / finops; acme-robotics and platform are
// historical slugs. Run frames come from `dataSource().runs.framesSince`, so the
// fixture streams the seeded run's frames; the fleet feed answers G3 until a
// port reads patches by cursor.
import { expect, setPageState, test } from "./support";

const stream = "/api/mc/acme/core-platform/stream";
const SEEDED_RUN = "run_01K5RS7M2E8FJ3QW";

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

  test("streams a seeded run's frames as SSE events, each with its seq as the id", async ({
    signedInPage: page,
  }) => {
    // A live stream stays open, so read it the way the Run page does: an
    // EventSource in the browser, closed once a few frames have arrived.
    await page.goto("/acme/core-platform");
    const frames = await page.evaluate(
      (url) =>
        new Promise<Array<{ id: string; seq: string; kind: string }>>(
          (resolve, reject) => {
            const seen: Array<{ id: string; seq: string; kind: string }> = [];
            const source = new EventSource(url);
            const timer = setTimeout(() => {
              source.close();
              reject(new Error(`only ${String(seen.length)} frames arrived`));
            }, 15_000);
            source.addEventListener("frame", (event) => {
              const message = event as MessageEvent<string>;
              const frame = JSON.parse(message.data) as {
                seq: string;
                kind: string;
              };
              seen.push({ id: message.lastEventId, ...frame });
              if (seen.length === 3) {
                clearTimeout(timer);
                source.close();
                resolve(seen);
              }
            });
          },
        ),
      `${stream}?run=${SEEDED_RUN}&after=0`,
    );
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame.id).toBe(frame.seq);
    const seqs = frames.map((f) => Number(f.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBeGreaterThan(0);
  });

  test("an unknown run streams its not-found state and closes, never an empty stream", async ({
    signedInPage: page,
  }) => {
    const res = await page.request.get(`${stream}?run=arun_01&after=0`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    expect(res.headers()["cache-control"]).toContain("no-store");
    const body = await res.text();
    expect(body).toContain("retry: 3000");
    expect(body).toContain("event: state");
    expect(body).toContain('"code":"run_not_found"');
  });

  test("a run page in its not_backed state streams that state and closes", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await setPageState(
      context,
      baseURL ?? "http://localhost:3000",
      "not_backed",
      "run",
    );
    const res = await page.request.get(`${stream}?run=${SEEDED_RUN}&after=0`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: state");
    expect(body).toContain('"reason":"not_backed"');
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
