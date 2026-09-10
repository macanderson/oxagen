import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectUrls,
  doiOf,
  extractUrls,
  main,
  mapLimit,
  probe,
} from "./check-links.mjs";

/** A fetch stand-in keyed by URL; unknown URLs 404. */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method });
    const status = table[url] ?? 404;
    if (status instanceof Error) throw status;
    return { ok: status >= 200 && status < 300, status };
  };
  fn.calls = calls;
  return fn;
}

describe("extractUrls", () => {
  it("finds distinct urls and strips trailing markdown punctuation", () => {
    const text =
      "See https://arxiv.org/abs/1.2. and (https://a.example/x), plus https://a.example/x again; https://b.example/y*";
    expect(extractUrls(text)).toEqual([
      "https://arxiv.org/abs/1.2",
      "https://a.example/x",
      "https://b.example/y",
    ]);
  });
});

describe("doiOf", () => {
  it("extracts a DOI from publisher and doi.org urls", () => {
    expect(doiOf("https://dl.acm.org/doi/10.1145/3418896")).toBe(
      "10.1145/3418896",
    );
    expect(doiOf("https://doi.org/10.1145/2635868.2635920?x=1")).toBe(
      "10.1145/2635868.2635920",
    );
    expect(doiOf("https://arxiv.org/abs/2310.06770")).toBeNull();
  });
});

describe("probe", () => {
  it("accepts a 2xx on HEAD without a GET", async () => {
    const f = fakeFetch({ "https://ok.example/": 200 });
    expect(await probe("https://ok.example/", f)).toEqual({
      url: "https://ok.example/",
      ok: true,
      status: 200,
    });
    expect(f.calls.map((c) => c.method)).toEqual(["HEAD"]);
  });

  it("retries with GET when HEAD is refused", async () => {
    let n = 0;
    const f = async (_url, init) => {
      n += 1;
      return init.method === "HEAD"
        ? { ok: false, status: 405 }
        : { ok: true, status: 200 };
    };
    expect(await probe("https://head-less.example/", f)).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(n).toBe(2);
  });

  it("settles a 403 on a DOI url through Crossref", async () => {
    const good = fakeFetch({
      "https://dl.acm.org/doi/10.1145/3418896": 403,
      "https://api.crossref.org/works/10.1145%2F3418896": 200,
    });
    expect(await probe("https://dl.acm.org/doi/10.1145/3418896", good)).toEqual(
      {
        url: "https://dl.acm.org/doi/10.1145/3418896",
        ok: true,
        status: 200,
        via: "crossref",
      },
    );
    const bad = fakeFetch({ "https://dl.acm.org/doi/10.1145/0000000": 403 });
    expect(
      await probe("https://dl.acm.org/doi/10.1145/0000000", bad),
    ).toMatchObject({ ok: false, status: 404, via: "crossref" });
  });

  it("reports a plain failure for a 403 with no DOI and for network errors", async () => {
    expect(
      await probe(
        "https://blocked.example/",
        fakeFetch({ "https://blocked.example/": 403 }),
      ),
    ).toEqual({ url: "https://blocked.example/", ok: false, status: 403 });
    const boom = fakeFetch({
      "https://down.example/": new Error("ECONNRESET"),
    });
    expect(await probe("https://down.example/", boom)).toEqual({
      url: "https://down.example/",
      ok: false,
      status: "ECONNRESET",
    });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(
      await probe(
        "https://slow.example/",
        fakeFetch({ "https://slow.example/": abort }),
      ),
    ).toMatchObject({ status: "timeout" });
  });
});

describe("mapLimit", () => {
  it("preserves order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit(
      [5, 1, 3, 2],
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, n));
        active -= 1;
        return n * 10;
      },
      2,
    );
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
    expect(await mapLimit([], async () => 1, 3)).toEqual([]);
  });
});

describe("collectUrls / main", () => {
  async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "oxagen-links-"));
    await mkdir(path.join(dir, "one"));
    await mkdir(path.join(dir, "two"));
    await mkdir(path.join(dir, "no-index"));
    await writeFile(
      path.join(dir, "one", "index.mdx"),
      "[^1]: https://arxiv.org/abs/1.1\n[^2]: https://shared.example/",
    );
    await writeFile(
      path.join(dir, "two", "index.mdx"),
      "https://shared.example/ and https://dead.example/",
    );
    await writeFile(path.join(dir, "stray.txt"), "https://ignored.example/");
    return dir;
  }

  it("maps each url to the posts that cite it", async () => {
    const dir = await fixture();
    const map = await collectUrls(dir);
    expect([...map.entries()].sort()).toEqual([
      ["https://arxiv.org/abs/1.1", ["one"]],
      ["https://dead.example/", ["two"]],
      ["https://shared.example/", ["one", "two"]],
    ]);
  });

  it("main logs every result and returns 1 when any url fails", async () => {
    const dir = await fixture();
    const lines = [];
    const f = fakeFetch({
      "https://arxiv.org/abs/1.1": 200,
      "https://shared.example/": 200,
    });
    const code = await main({
      postsDir: dir,
      fetchImpl: f,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines[0]).toBe("checking 3 distinct URLs across 2 posts");
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^FAIL 404 {5}https:\/\/dead\.example\/ {3}\(two\)$/,
      ),
    );
    expect(lines.at(-1)).toBe("\n2 ok, 1 failed");
  });

  it("main returns 0 when everything resolves", async () => {
    const dir = await fixture();
    const f = fakeFetch({
      "https://arxiv.org/abs/1.1": 200,
      "https://shared.example/": 200,
      "https://dead.example/": 403,
    });
    expect(await main({ postsDir: dir, fetchImpl: f, log: () => {} })).toBe(1);
    const all = fakeFetch({
      "https://arxiv.org/abs/1.1": 200,
      "https://shared.example/": 200,
      "https://dead.example/": 200,
    });
    expect(await main({ postsDir: dir, fetchImpl: all, log: () => {} })).toBe(
      0,
    );
  });
});
