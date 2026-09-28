import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import type { HttpParameter } from "../model/upstream-tool";
import { importOpenApi } from ".";
import type { JsonRecord } from "./json";
import { detectPaging } from "./paging";

function query(name: string, property = name): HttpParameter {
  return { name, in: "query", property, required: false };
}

function object(properties: JsonRecord): JsonRecord {
  return { type: "object", properties };
}

const list = { type: "array", items: { type: "object" } };

describe("detectPaging", () => {
  it("records cursor paging when the result names the next cursor", () => {
    const output = object({ data: list, next_cursor: { type: "string" }, has_more: { type: "boolean" } });
    expect(detectPaging([query("cursor"), query("limit")], output, false)).toStrictEqual({
      style: "cursor",
      input: "cursor",
      items: "data",
      next: "next_cursor",
      has_more: "has_more",
      limit: "limit",
    });
  });

  it("finds the next cursor and has_more one level down", () => {
    const output = object({
      results: list,
      meta: object({ nextPageToken: { type: ["string", "null"] }, hasNextPage: { type: "boolean" } }),
    });
    expect(detectPaging([query("pageToken")], output, false)).toStrictEqual({
      style: "cursor",
      input: "pageToken",
      items: "results",
      next: "meta.nextPageToken",
      has_more: "meta.hasNextPage",
    });
  });

  it("carries the parameter's input property, not its name", () => {
    const output = object({ items: list, next_token: { type: "string" } });
    expect(detectPaging([query("next_token", "next_token_query")], output, false)).toMatchObject({
      style: "cursor",
      input: "next_token_query",
    });
  });

  it("falls through to page paging when no field names the next cursor", () => {
    const output = object({ data: list, next_cursor: { type: "integer" } });
    expect(detectPaging([query("cursor"), query("page")], output, false)).toStrictEqual({
      style: "page",
      input: "page",
      items: "data",
    });
  });

  it("records no paging for a cursor parameter alone when no field names the next cursor", () => {
    const output = object({ data: list, cursor: { type: "string" } });
    expect(detectPaging([query("cursor")], output, false)).toBeUndefined();
  });

  it("prefers per_page over limit for page paging", () => {
    const output = object({ data: list });
    expect(detectPaging([query("page"), query("limit"), query("per_page")], output, false)).toStrictEqual({
      style: "page",
      input: "page",
      items: "data",
      limit: "per_page",
    });
  });

  it("prefers limit over per_page for offset paging", () => {
    const output = object({ records: list });
    expect(detectPaging([query("offset"), query("per_page"), query("limit")], output, false)).toStrictEqual({
      style: "offset",
      input: "offset",
      items: "records",
      limit: "limit",
    });
  });

  it("reads the wrapped items of an array result", () => {
    const output = object({ items: list });
    expect(detectPaging([query("skip"), query("top")], output, true)).toStrictEqual({
      style: "offset",
      input: "skip",
      items: "items",
      limit: "top",
    });
  });

  it("counts only query parameters as paging inputs", () => {
    const output = object({ data: list, next_cursor: { type: "string" } });
    const parameters: HttpParameter[] = [
      { name: "cursor", in: "header", property: "cursor", required: false },
      { name: "page", in: "path", property: "page", required: true },
    ];
    expect(detectPaging(parameters, output, false)).toBeUndefined();
  });

  it("records no paging without an output schema", () => {
    expect(detectPaging([query("page")], undefined, false)).toBeUndefined();
  });

  it("records no paging when the result has no array to add pages to", () => {
    expect(detectPaging([query("page")], object({ total: { type: "integer" } }), false)).toBeUndefined();
    expect(detectPaging([query("page")], { type: "object" }, false)).toBeUndefined();
  });

  it("takes the one array property when none has a known name", () => {
    const output = object({ charges: { items: { type: "string" } }, total: { type: "integer" } });
    expect(detectPaging([query("page")], output, false)).toMatchObject({ items: "charges" });
  });

  it("records no paging when two unknown arrays compete", () => {
    const output = object({ charges: list, refunds: list });
    expect(detectPaging([query("page")], output, false)).toBeUndefined();
  });

  it("records no paging when the one array's name is not a result path", () => {
    const output = object({ "charge-list": list });
    expect(detectPaging([query("page")], output, false)).toBeUndefined();
  });

  it("reads a nullable array as an array, and a mixed type list as not one", () => {
    expect(detectPaging([query("page")], object({ data: { type: ["array", "null"] } }), false)).toMatchObject({
      items: "data",
    });
    expect(detectPaging([query("page")], object({ data: { type: ["array", "string"] } }), false)).toBeUndefined();
  });

  it("skips a nested parent that is not a result path or not a schema", () => {
    const output = object({
      data: list,
      "page-info": object({ next_cursor: { type: "string" } }),
      links: true,
    });
    expect(detectPaging([query("cursor")], output, false)).toBeUndefined();
  });
});

/** A one-file OpenAPI 3.1 document holding `paths`, as import input. */
function documentWith(paths: JsonRecord) {
  const text = stringify({ openapi: "3.1.0", info: { title: "Paging", version: "1" }, paths });
  return { files: [{ path: "openapi.yaml", text }], entry: "openapi.yaml", overlay: undefined };
}

function json(schema: JsonRecord): JsonRecord {
  return { "200": { description: "OK", content: { "application/json": { schema } } } };
}

function queryParameter(name: string, type = "string"): JsonRecord {
  return { name, in: "query", schema: { type } };
}

describe("paging through import", () => {
  const paths = {
    "/charges": {
      get: {
        operationId: "listCharges",
        parameters: [queryParameter("cursor"), queryParameter("limit", "integer")],
        responses: json(object({ data: list, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } })),
      },
    },
    "/invoices": {
      get: {
        operationId: "listInvoices",
        parameters: [queryParameter("page", "integer"), queryParameter("per_page", "integer")],
        responses: json(list),
      },
    },
    "/reports": {
      get: {
        operationId: "listReports",
        parameters: [queryParameter("q")],
        responses: json(object({ data: list })),
      },
    },
  };

  it("records cursor, page, and no paging on the matching operations", async () => {
    const result = await importOpenApi(documentWith(paths));
    const paging = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.paging ?? null]));
    expect(paging).toStrictEqual({
      list_charges: { style: "cursor", input: "cursor", items: "data", next: "next_cursor", has_more: "has_more", limit: "limit" },
      list_invoices: { style: "page", input: "page", items: "items", limit: "per_page" },
      list_reports: null,
    });
  });

  it("wraps the array result that page paging adds to", async () => {
    const result = await importOpenApi(documentWith(paths));
    const invoices = result.tools.find((tool) => tool.name === "list_invoices")!;
    expect(invoices.request).toMatchObject({ kind: "http", response: { status: "200", wrap: "items" } });
    expect(invoices.outputSchema).toMatchObject({ type: "object", required: ["items"] });
  });
});
