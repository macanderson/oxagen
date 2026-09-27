// paging.ts: every rule that ends auto paging, and the note each one leaves.
// A scripted send stands in for the Sender, so each page is exact.
import { describe, expect, it } from "vitest";
import type { RecordedExchange } from "../contract/tests-files";
import type { Paging } from "../model/upstream-tool";
import { errorText, itemsPath, pagingNote, sendPages, type PagedValue, type PagingOptions } from "./paging";
import type { SendError, SendResult, UpstreamArguments } from "./sender";

const CURSOR: Paging = { style: "cursor", input: "starting_after", next: "next_cursor", items: "data" };

function options(overrides: Partial<PagingOptions["shaping"]> = {}, extra: Partial<PagingOptions> = {}): PagingOptions {
  return {
    shaping: { deadline_ms: 30_000, max_result_bytes: 65_536, ...overrides },
    inputSchema: { type: "object", properties: {} },
    agentName: (name) => name,
    measure: (value) => JSON.stringify(value).length,
    ...extra,
  };
}

class Failure {
  constructor(readonly error: SendError) {}
}

interface Script {
  send: (args: UpstreamArguments, deadline_ms: number) => Promise<SendResult>;
  calls: Array<{ args: UpstreamArguments; deadline_ms: number }>;
}

/** A send that answers call n with pages[n - 1]: a value, or a SendError to fail with. */
function script(pages: ReadonlyArray<unknown>): Script {
  const calls: Script["calls"] = [];
  return {
    calls,
    send: (args, deadline_ms) => {
      calls.push({ args, deadline_ms });
      const page = pages[calls.length - 1];
      const exchanges: RecordedExchange[] = [
        { request: { method: "GET", path: `/page/${calls.length}` }, response: { status: 200 } },
      ];
      if (page instanceof Failure) return Promise.resolve({ ok: false, error: page.error, attempts: 1, exchanges });
      return Promise.resolve({ ok: true, value: page, attempts: 1, exchanges });
    },
  };
}

const UNAVAILABLE = new Failure({ title: "Service Unavailable", detail: "The upstream is down", status: 503 });

function items(from: number, count: number): Array<{ id: number }> {
  return Array.from({ length: count }, (_, index) => ({ id: from + index }));
}

function paged(result: Awaited<ReturnType<typeof sendPages>>): PagedValue {
  expect(result.ok).toBe(true);
  if (!result.ok || result.paged === undefined) throw new Error("expected a paged value");
  return result.paged;
}

describe("itemsPath", () => {
  it("drops a trailing []", () => {
    expect(itemsPath({ ...CURSOR, items: "data[]" })).toBe("data");
    expect(itemsPath({ ...CURSOR, items: "result.edges" })).toBe("result.edges");
  });
});

describe("cursor paging", () => {
  it("stops at max_items, keeps only max_items items, and sends each cursor", async () => {
    const pages = script([
      { data: items(1, 3), next_cursor: "c1" },
      { data: items(4, 3), next_cursor: "c2" },
      { data: items(7, 3), next_cursor: "c3" },
    ]);
    const result = await sendPages(CURSOR, { limit: 3 }, options({ max_items: 5 }), pages.send);
    const value = paged(result);
    expect(pages.calls.map((call) => call.args)).toEqual([{ limit: 3 }, { limit: 3, starting_after: "c1" }]);
    expect(value).toMatchObject({ pages: 2, items: 5, stop: "max_items" });
    expect(value.value).toEqual({ data: items(1, 5), next_cursor: "c2" });
    expect(result.ok && result.exchanges.map((exchange) => exchange.request)).toEqual([
      { method: "GET", path: "/page/1" },
      { method: "GET", path: "/page/2" },
    ]);
    expect(pagingNote(value, options())).toBe(
      "Auto paging stopped at max_items: the result holds 5 items from 2 pages, and more may remain.",
    );
  });

  it("stops when the cursor is absent, null, or empty", async () => {
    for (const next of [undefined, null, ""]) {
      const pages = script([{ data: items(1, 2), next_cursor: "c1" }, { data: items(3, 1), next_cursor: next }]);
      const value = paged(await sendPages(CURSOR, {}, options(), pages.send));
      expect(value).toMatchObject({ pages: 2, items: 3, stop: "last_page" });
      expect(pagingNote(value, options())).toBeUndefined();
    }
  });

  it("stops at a cursor it already sent, including the agent's own", async () => {
    const repeated = script([{ data: items(1, 1), next_cursor: "c1" }, { data: items(2, 1), next_cursor: "c1" }]);
    const value = paged(await sendPages(CURSOR, {}, options(), repeated.send));
    expect(value).toMatchObject({ pages: 2, items: 2, stop: "repeated_cursor" });
    expect(pagingNote(value, options())).toBe(
      "Auto paging stopped because the upstream sent a cursor it had sent before: the result holds 2 items from 2 pages.",
    );

    const own = script([{ data: items(1, 1), next_cursor: "start" }]);
    expect(paged(await sendPages(CURSOR, { starting_after: "start" }, options(), own.send)).stop).toBe("repeated_cursor");
    expect(own.calls).toHaveLength(1);
  });

  it("reads one page when the paging has no next path", async () => {
    const pages = script([{ data: items(1, 2) }]);
    const value = paged(await sendPages({ ...CURSOR, next: undefined }, {}, options(), pages.send));
    expect(value).toMatchObject({ pages: 1, items: 2, stop: "last_page" });
  });

  it("stops when has_more is present and not true", async () => {
    const paging: Paging = { ...CURSOR, has_more: "has_more" };
    const pages = script([
      { data: items(1, 2), has_more: true, next_cursor: "c1" },
      { data: items(3, 2), has_more: false, next_cursor: "c2" },
    ]);
    const value = paged(await sendPages(paging, {}, options(), pages.send));
    expect(value).toMatchObject({ pages: 2, items: 4, stop: "last_page" });
    expect(pages.calls).toHaveLength(2);
  });

  it("follows a connection's end cursor", async () => {
    const paging: Paging = {
      style: "connection",
      input: "after",
      next: "pageInfo.endCursor",
      has_more: "pageInfo.hasNextPage",
      items: "edges",
    };
    const pages = script([
      { edges: items(1, 2), pageInfo: { endCursor: "e1", hasNextPage: true } },
      { edges: items(3, 1), pageInfo: { endCursor: "e2", hasNextPage: false } },
    ]);
    const value = paged(await sendPages(paging, {}, options(), pages.send));
    expect(pages.calls[1]?.args).toEqual({ after: "e1" });
    expect(value.value).toEqual({ edges: items(1, 3), pageInfo: { endCursor: "e2", hasNextPage: false } });
  });
});

describe("page and offset paging", () => {
  const PAGE: Paging = { style: "page", input: "page", items: "results" };

  it("stops at an empty page and keeps the items before it", async () => {
    const pages = script([{ results: items(1, 2) }, { results: items(3, 2) }, { results: [] }]);
    const value = paged(await sendPages(PAGE, {}, options(), pages.send));
    expect(pages.calls.map((call) => call.args)).toEqual([{}, { page: 2 }, { page: 3 }]);
    expect(value).toMatchObject({ pages: 3, items: 4, stop: "last_page" });
    expect(value.value).toEqual({ results: items(1, 4) });
  });

  it("starts from the page the agent sent, and sends a string page back as a string", async () => {
    const pages = script([{ results: items(1, 1) }, { results: [] }]);
    await sendPages(PAGE, { page: "4" }, options(), pages.send);
    expect(pages.calls.map((call) => call.args)).toEqual([{ page: "4" }, { page: "5" }]);
  });

  it("starts from the schema's default, then its minimum, under the agent's name", async () => {
    const renamed = options({}, {
      inputSchema: { type: "object", properties: { page_number: { type: "integer", default: 0 } } },
      agentName: (name) => (name === "page" ? "page_number" : name),
    });
    const fromDefault = script([{ results: items(1, 1) }, { results: [] }]);
    await sendPages(PAGE, {}, renamed, fromDefault.send);
    expect(fromDefault.calls[1]?.args).toEqual({ page: 1 });

    const minimum = options({}, { inputSchema: { type: "object", properties: { page: { type: "integer", minimum: 0 } } } });
    const fromMinimum = script([{ results: items(1, 1) }, { results: [] }]);
    await sendPages(PAGE, {}, minimum, fromMinimum.send);
    expect(fromMinimum.calls[1]?.args).toEqual({ page: 1 });

    const bare = options({}, { inputSchema: { type: "object", properties: { page: { type: "integer" } } } });
    const fromOne = script([{ results: items(1, 1) }, { results: [] }]);
    await sendPages(PAGE, {}, bare, fromOne.send);
    expect(fromOne.calls[1]?.args).toEqual({ page: 2 });
  });

  it("moves an offset by the items each page returned", async () => {
    const paging: Paging = { style: "offset", input: "offset", items: "data" };
    const pages = script([{ data: items(1, 3) }, { data: items(4, 2) }, { data: [] }]);
    await sendPages(paging, {}, options(), pages.send);
    expect(pages.calls.map((call) => call.args)).toEqual([{}, { offset: 3 }, { offset: 5 }]);
  });
});

describe("the call's limits", () => {
  it("gives the first page the whole deadline and later pages what is left, then stops at the deadline", async () => {
    let clock = 1_000;
    const pages = script([
      { data: items(1, 1), next_cursor: "c1" },
      { data: items(2, 1), next_cursor: "c2" },
      { data: items(3, 1), next_cursor: "c3" },
    ]);
    const send: Script["send"] = async (args, deadline_ms) => {
      const result = await pages.send(args, deadline_ms);
      clock += 400;
      return result;
    };
    const value = paged(await sendPages(CURSOR, {}, options({ deadline_ms: 1_000 }, { now: () => clock }), send));
    expect(pages.calls.map((call) => call.deadline_ms)).toEqual([1_000, 600, 200]);
    expect(value).toMatchObject({ pages: 3, items: 3, stop: "deadline" });
    expect(pagingNote(value, options({ deadline_ms: 1_000 }))).toBe(
      "Auto paging stopped at the 1000 ms deadline: the result holds 3 items from 3 pages, and more may remain.",
    );
  });

  it("stops once the pages pass the result limit", async () => {
    const pages = script([
      { data: items(1, 1), next_cursor: "c1" },
      { data: items(2, 1), next_cursor: "c2" },
      { data: items(3, 1), next_cursor: "c3" },
    ]);
    const value = paged(await sendPages(CURSOR, {}, options({ max_result_bytes: 60 }), pages.send));
    expect(value).toMatchObject({ pages: 2, items: 2, stop: "size" });
    expect(pagingNote(value, options({ max_result_bytes: 60 }))).toBe(
      "Auto paging stopped at the 60-byte result limit: the result holds 2 items from 2 pages, and more may remain.",
    );
  });
});

describe("failures", () => {
  it("fails the call when the first page fails", async () => {
    const pages = script([UNAVAILABLE]);
    const result = await sendPages(CURSOR, {}, options(), pages.send);
    expect(result).toEqual({
      ok: false,
      error: UNAVAILABLE.error,
      exchanges: [{ request: { method: "GET", path: "/page/1" }, response: { status: 200 } }],
    });
  });

  it("keeps the items so far when a later page fails, and names the error", async () => {
    const pages = script([{ data: items(1, 2), next_cursor: "c1" }, UNAVAILABLE]);
    const result = await sendPages(CURSOR, {}, options(), pages.send);
    const value = paged(result);
    expect(value).toMatchObject({ pages: 1, items: 2, stop: "failed", error: UNAVAILABLE.error });
    expect(result.ok && result.exchanges).toHaveLength(2);
    expect(pagingNote(value, options())).toBe(
      "Auto paging stopped because page 2 failed: the result holds 2 items from 1 page. Service Unavailable (status 503): The upstream is down.",
    );
  });

  it("returns the first page as it came when it has no item list", async () => {
    const pages = script([{ message: "not a list" }]);
    const result = await sendPages(CURSOR, {}, options(), pages.send);
    expect(result).toMatchObject({ ok: true, paged: undefined, value: { message: "not a list" } });
  });

  it("stops when a later page has no item list", async () => {
    const pages = script([{ data: items(1, 1), next_cursor: "c1" }, { data: "gone" }]);
    const value = paged(await sendPages(CURSOR, {}, options(), pages.send));
    expect(value).toMatchObject({ pages: 1, items: 1, stop: "no_items" });
    expect(pagingNote(value, options())).toBe(
      "Auto paging stopped because page 2 held no item list: the result holds 1 item from 1 page.",
    );
  });
});

describe("errorText", () => {
  it("names the status when there is one", () => {
    expect(errorText({ title: "Not Found", detail: "No charge ch_1.", status: 404 })).toBe(
      "Not Found (status 404): No charge ch_1.",
    );
    expect(errorText({ title: "Deadline exceeded", detail: "No answer in 30000 ms.", status: undefined })).toBe(
      "Deadline exceeded: No answer in 30000 ms.",
    );
  });

  it("ends a failed note's reason with one period", () => {
    const value: PagedValue = {
      value: {},
      pages: 1,
      items: 1,
      stop: "failed",
      error: { title: "Bad Gateway", detail: "Try again.", status: 502 },
    };
    expect(pagingNote(value, options())).toBe(
      "Auto paging stopped because page 2 failed: the result holds 1 item from 1 page. Bad Gateway (status 502): Try again.",
    );
    const bare: PagedValue = { value: {}, pages: 1, items: 1, stop: "failed" };
    expect(pagingNote(bare, options())).toBe("Auto paging stopped because page 2 failed: the result holds 1 item from 1 page.");
  });
});
