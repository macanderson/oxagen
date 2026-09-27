// diff: every class of tool surface change, with goldens from the billing and
// stripe fixtures. Each side is compiled and locked from the fixtures, so the
// hashes and versions are the ones lock writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, toManifestServer, type CompileInput } from "../compile";
import { isRecord } from "../compile/json-schema";
import { definitionLockSourceSchema, type McpToolsLock } from "../contract/lock";
import { mcpToolsListResultSchema } from "../contract/mcp-tool";
import { parseLock, parseServerToml, parseToolsToml, type ReadResult } from "../contract/parse";
import { mcpServerSchema } from "../contract/server";
import { mcpToolsSchema, type McpTools } from "../contract/tools";
import { lock, type LockInput } from "../lock";
import { upstreamFromMcpTool } from "../model/from-mcp";
import { upstreamToolSchema, type UpstreamTool } from "../model/upstream-tool";
import { diff, type DiffSide, type ToolSurfaceDiff, type ToolSurfaceDiffEntry } from "./index";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function text(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function json(path: string): unknown {
  return JSON.parse(text(path)) as unknown;
}

/** The value of a parse that must succeed. A failure shows its issues. */
function ok<T>(result: ReadResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.value;
}

// ── Sides ────────────────────────────────────────────────────────────────────

type FixtureServer = "billing" | "stripe";

/** Fields merged into an entry or tool by name. null drops it. */
type Replace = Record<string, Record<string, unknown> | null>;

function pinnedLock(name: FixtureServer): McpToolsLock {
  return ok(parseLock(text(`servers/${name}/tools.lock.json`)));
}

/** A fixture's tools.toml with entries changed, added, or dropped. */
function toolsToml(name: FixtureServer, replace: Replace = {}): McpTools {
  const parsed = ok(parseToolsToml(text(`servers/${name}/tools.toml`)));
  const tools = parsed.tools ?? {};
  const keys = [...new Set([...Object.keys(tools), ...Object.keys(replace)])];
  const entries = Object.fromEntries(
    keys.flatMap((key): Array<[string, Record<string, unknown>]> => {
      const change = Object.hasOwn(replace, key) ? replace[key] : undefined;
      if (change === null) return [];
      const current = Object.hasOwn(tools, key) ? tools[key] : undefined;
      return [[key, { ...current, ...change }]];
    }),
  );
  return mcpToolsSchema.parse({ ...parsed, tools: entries });
}

/** Raw upstream tools with fields merged in by name, and new tools appended. */
function merged(tools: unknown, replace: Replace, added: ReadonlyArray<Record<string, unknown>>): unknown[] {
  const kept = (Array.isArray(tools) ? tools : []).filter(isRecord).flatMap((tool) => {
    const name = typeof tool.name === "string" ? tool.name : "";
    const change = Object.hasOwn(replace, name) ? replace[name] : undefined;
    return change === null ? [] : [{ ...tool, ...change }];
  });
  return [...kept, ...added];
}

/** stripe's tools/list with tools changed or dropped, as upstreamFromMcpTool returns it. */
function stripeUpstream(replace: Replace = {}): UpstreamTool[] {
  const list = json("sources/stripe/tools-list.json");
  const tools = merged(isRecord(list) ? list.tools : [], replace, []);
  return mcpToolsListResultSchema.parse({ tools }).tools.map(upstreamFromMcpTool);
}

/** billing's imported operations with some changed, dropped, or added. */
function billingUpstream(replace: Replace = {}, added: ReadonlyArray<Record<string, unknown>> = []): UpstreamTool[] {
  return upstreamToolSchema.array().parse(merged(json("expected/billing/upstream.json"), replace, added));
}

/** Compile, lock against the side before, and build the manifest entry. */
function side(input: CompileInput, source: LockInput["source"], previous?: DiffSide): DiffSide {
  const compiled = compile(input);
  const locked = lock({ compiled, source, previous: previous?.lock });
  return { lock: locked, server: toManifestServer(compiled, locked) };
}

function fixtureSide(
  name: FixtureServer,
  tools: McpTools,
  upstream: readonly UpstreamTool[],
  previous?: DiffSide,
): DiffSide {
  const pinned = pinnedLock(name).source;
  const input: CompileInput = {
    server: ok(parseServerToml(text(`servers/${name}/server.toml`))),
    tools,
    upstream,
    security_schemes: pinned.type === "openapi" ? (pinned.security_schemes ?? {}) : {},
    descriptor_set: undefined,
  };
  return side(input, pinned, previous);
}

interface StripeEdit {
  tools?: Replace;
  upstream?: Replace;
}

/**
 * The diff between stripe's fixtures with the served edits and with the
 * proposed ones. The source offers the proposed tools/list.
 */
function stripeDiff(served: StripeEdit = {}, proposed: StripeEdit = {}): ToolSurfaceDiff {
  const before = fixtureSide("stripe", toolsToml("stripe", served.tools), stripeUpstream(served.upstream));
  const upstream = stripeUpstream(proposed.upstream);
  const after = fixtureSide("stripe", toolsToml("stripe", proposed.tools), upstream, before);
  return diff({ served: before, proposed: after, offered: upstream });
}

type Changed = Extract<ToolSurfaceDiffEntry, { change: "changed" }>;

function changeOf(result: ToolSurfaceDiff, key: string): Changed {
  const entry = result.entries.find((item) => item.change === "changed" && item.key === key);
  if (entry === undefined || entry.change !== "changed") throw new Error(`The diff has no changed entry for ${key}.`);
  return entry;
}

/** A list_charges result with these item fields and these top-level fields. */
function chargesOutput(
  items: Record<string, unknown>,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "object",
    properties: { data: { type: "array", items: { type: "object", properties: items } }, ...fields },
  };
}

const ID = { type: "string" };
const INTEGER = { type: "integer" };

// ── Goldens ──────────────────────────────────────────────────────────────────

const CHARGES_SELECT = { select: ["data[].id", "data[].amount", "data[].status", "next_cursor"] };

const VOID_INVOICE = {
  name: "void_invoice",
  description: "Void an open invoice.",
  inputSchema: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] },
  request: {
    kind: "http",
    operation: "voidInvoice",
    method: "POST",
    path: "/invoices/{invoice_id}/void",
    parameters: [{ in: "path", name: "invoice_id", property: "invoice_id", required: true }],
    security: [{ oauth: ["billing"] }],
  },
};

const LIST_DISPUTES = {
  name: "list_disputes",
  description: "List disputes.",
  inputSchema: { type: "object" },
  request: {
    kind: "http",
    operation: "listDisputes",
    method: "GET",
    path: "/disputes",
    parameters: [],
    security: [{ oauth: ["billing"] }],
  },
};

/** create_refund with a required currency, and without the fraudulent reason. */
const REFUND_WITH_CURRENCY = {
  inputSchema: {
    type: "object",
    properties: {
      "X-Request-Source": { type: "string" },
      amount: { type: "integer", minimum: 1 },
      charge_id: { type: "string", description: "The charge to refund." },
      currency: { type: "string", description: "ISO 4217" },
      reason: { type: "string", enum: ["duplicate", "requested_by_customer"] },
    },
    required: ["charge_id", "currency"],
  },
  request: {
    kind: "http",
    operation: "createRefund",
    method: "POST",
    path: "/refunds",
    parameters: [{ in: "header", name: "X-Request-Source", property: "X-Request-Source", required: false }],
    body: {
      in: "spread",
      media_type: "application/json",
      properties: ["charge_id", "amount", "reason", "currency"],
      required: true,
    },
    response: { media_type: "application/json", status: "201" },
    security: [{ oauth: ["billing"] }],
  },
};

const CHARGES_WITH_FEE = chargesOutput(
  {
    amount: INTEGER,
    currency: { type: "string" },
    fee: INTEGER,
    id: ID,
    status: { type: "string", enum: ["pending", "succeeded", "failed"] },
  },
  { next_cursor: { type: "string" } },
);

describe("diff with the fixtures", () => {
  it("marks billing's new required input, narrowed enum, and removed operation as breaking", () => {
    const served = fixtureSide(
      "billing",
      toolsToml("billing", {
        list_charges: CHARGES_SELECT,
        void_invoice: { operation: "voidInvoice", risk: "high", side_effect: "irreversible", egress: "org_tenant" },
      }),
      billingUpstream({}, [VOID_INVOICE]),
    );
    const offered = billingUpstream(
      { create_refund: REFUND_WITH_CURRENCY, list_charges: { outputSchema: CHARGES_WITH_FEE } },
      [LIST_DISPUTES],
    );
    const proposed = fixtureSide("billing", toolsToml("billing", { list_charges: CHARGES_SELECT }), offered, served);

    expect(diff({ served, proposed, offered })).toStrictEqual({
      server: "billing",
      entries: [
        { change: "offered", upstream: "get_charge" },
        { change: "offered", upstream: "list_disputes" },
        {
          change: "changed",
          key: "create_refund",
          tool: "billing__create_refund",
          version: { served: 1, proposed: 2 },
          breaking: [
            { reason: "new_required_input", detail: "new required input: currency (string, ISO 4217)" },
            { reason: "narrowed_type", detail: 'input reason: no longer accepts "fraudulent"' },
          ],
          description: undefined,
          notes: [],
        },
        {
          change: "changed",
          key: "list_charges",
          tool: "billing__list_charges",
          version: { served: 1, proposed: 1 },
          breaking: [],
          description: undefined,
          notes: ["response field data[].fee added (not in select, not returned)"],
        },
        {
          change: "removed",
          key: "void_invoice",
          tool: "billing__void_invoice",
          breaking: [{ reason: "removed_tool", detail: "operation removed from the document" }],
          notes: [],
        },
      ],
      tokens: { served: served.server.tokens.request, proposed: proposed.server.tokens.request, budget: 8000 },
      breaking: true,
    });
  });

  it("shows stripe's new upstream description only where tools.toml sets none", () => {
    const result = stripeDiff(
      {},
      {
        upstream: {
          create_refund: { description: "Create a refund for a charge, in full or in part." },
          list_charges: { description: "List charges, newest first. Includes refunded charges." },
        },
      },
    );
    expect(result.server).toBe("stripe");
    expect(result.entries).toStrictEqual([
      { change: "offered", upstream: "create_customer" },
      {
        change: "changed",
        key: "create_refund",
        tool: "stripe__create_refund",
        version: { served: 1, proposed: 1 },
        breaking: [],
        description: undefined,
        notes: ["upstream description changed, and the tools.toml description is still served"],
      },
      {
        change: "changed",
        key: "list_charges",
        tool: "stripe__list_charges",
        version: { served: 1, proposed: 2 },
        breaking: [],
        description: {
          served: "List charges, newest first.",
          proposed: "List charges, newest first. Includes refunded charges.",
        },
        notes: [],
      },
    ]);
    expect(result.tokens.budget).toBe(8000);
    expect(result.breaking).toBe(false);
  });

  it("lists only the offered tools when nothing changed", () => {
    const result = stripeDiff();
    expect(result.entries).toStrictEqual([{ change: "offered", upstream: "create_customer" }]);
    expect(result.breaking).toBe(false);
  });
});

// ── Tools ────────────────────────────────────────────────────────────────────

describe("diff adds and removes tools", () => {
  it("adds a tool the proposed tools.toml imports", () => {
    expect(stripeDiff({ tools: { list_charges: null } }).entries).toStrictEqual([
      { change: "offered", upstream: "create_customer" },
      { change: "added", key: "list_charges", tool: "stripe__list_charges", version: 1 },
    ]);
  });

  it("breaks a tool tools.toml drops, and offers it again", () => {
    const result = stripeDiff({}, { tools: { list_charges: null } });
    expect(result.entries).toStrictEqual([
      { change: "offered", upstream: "create_customer" },
      { change: "offered", upstream: "list_charges" },
      {
        change: "removed",
        key: "list_charges",
        tool: "stripe__list_charges",
        breaking: [{ reason: "removed_tool", detail: "removed from tools.toml" }],
        notes: [],
      },
    ]);
    expect(result.breaking).toBe(true);
  });

  it("breaks a tool tools/list no longer sends", () => {
    const result = stripeDiff({}, { tools: { list_charges: null }, upstream: { list_charges: null } });
    expect(result.entries).toStrictEqual([
      { change: "offered", upstream: "create_customer" },
      {
        change: "removed",
        key: "list_charges",
        tool: "stripe__list_charges",
        breaking: [{ reason: "removed_tool", detail: "tool removed from tools/list" }],
        notes: [],
      },
    ]);
  });

  const READ = { risk: "low", side_effect: "read", egress: "third_party" } as const;
  type DefinitionType = "openapi" | "graphql" | "grpc";

  function definitionSide(
    type: DefinitionType,
    entries: Record<string, Record<string, unknown>>,
    upstream: UpstreamTool[],
    previous?: DiffSide,
  ): DiffSide {
    const server = mcpServerSchema.parse({
      schema: "mcp-server/v1",
      name: "acme",
      label: "Acme",
      description: "Issues and repositories in the Acme tracker.",
      source: { type, from: "url", url: `https://docs.acme.example/${type}` },
      auth: { mode: "none" },
      exposure: { mode: "direct" },
      sync: { schedule: "daily" },
      environments: { prod: { url: "https://api.acme.example/v1" } },
    });
    const source = definitionLockSourceSchema.parse({
      type,
      from: "url",
      url: `https://docs.acme.example/${type}`,
      document_hash: `sha256:${"0".repeat(64)}`,
    });
    const input: CompileInput = {
      server,
      tools: mcpToolsSchema.parse({ schema: "mcp-tools/v1", tools: entries }),
      upstream,
      security_schemes: {},
      descriptor_set: type === "grpc" ? new Uint8Array([1, 2, 3]) : undefined,
    };
    return side(input, source, previous);
  }

  it.each<[DefinitionType, Record<string, unknown>, Record<string, unknown>, string]>([
    [
      "openapi",
      { ...READ, operation: "getThing" },
      {
        name: "getThing",
        request: { kind: "http", operation: "getThing", method: "GET", path: "/things", parameters: [] },
      },
      "operation removed from the document",
    ],
    [
      "graphql",
      { ...READ, field: "Query.issue" },
      {
        name: "Query.issue",
        request: { kind: "graphql", operation_type: "query", field: "Query.issue", arguments: [], selection: "{ id }" },
      },
      "field removed from the schema",
    ],
    [
      "grpc",
      { ...READ, method: "acme.ledger.v1.Ledger/PostEntry" },
      {
        name: "PostEntry",
        request: {
          kind: "grpc",
          method: "acme.ledger.v1.Ledger/PostEntry",
          streaming: "unary",
          idempotency_level: "NO_SIDE_EFFECTS",
          request_type: "acme.ledger.v1.Request",
          response_type: "acme.ledger.v1.Response",
        },
      },
      "method removed from the service definition",
    ],
  ])("says a %s source no longer offers a removed tool", (type, entry, fields, detail) => {
    const upstream = upstreamToolSchema.parse({ inputSchema: { type: "object" }, ...fields });
    const served = definitionSide(type, { thing: entry }, [upstream]);
    const proposed = definitionSide(type, {}, [], served);
    expect(diff({ served, proposed, offered: [] }).entries).toStrictEqual([
      {
        change: "removed",
        key: "thing",
        tool: "acme__thing",
        breaking: [{ reason: "removed_tool", detail }],
        notes: [],
      },
    ]);
  });
});

// ── Inputs ───────────────────────────────────────────────────────────────────

/** stripe's create_refund with one input, value, served as one schema and proposed as another. */
function valueDiff(served: Record<string, unknown>, proposed: Record<string, unknown>): Changed {
  const input = (value: Record<string, unknown>) => ({ inputSchema: { type: "object", properties: { value } } });
  const result = stripeDiff(
    { upstream: { create_refund: input(served) } },
    { upstream: { create_refund: input(proposed) } },
  );
  return changeOf(result, "create_refund");
}

describe("diff reads each input the agent sends", () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>, string[]]>([
    ["a new type", { type: "string" }, { type: "integer" }, ["input value: type string → integer"]],
    ["number narrowed to integer", { type: "number" }, { type: "integer" }, ["input value: type number → integer"]],
    ["integer widened to number", { type: "integer" }, { type: "number" }, []],
    ["a type on an untyped input", {}, { type: "string" }, ["input value: type any → string"]],
    ["a dropped type", { type: "string" }, {}, []],
    ["a type that adds null", { type: "string" }, { type: ["string", "null"] }, []],
    ["a new enum", { type: "string" }, { type: "string", enum: ["a", "b"] }, ['input value: accepts only "a", "b"']],
    [
      "a smaller enum",
      { type: "string", enum: ["a", "b"] },
      { type: "string", enum: ["a"] },
      ['input value: no longer accepts "b"'],
    ],
    ["a larger enum", { type: "string", enum: ["a"] }, { type: "string", enum: ["a", "b"] }, []],
    ["a new const", { type: "string" }, { type: "string", const: "a" }, ['input value: accepts only "a"']],
    ["the same const", { const: "a" }, { const: "a", description: "Always a." }, []],
    [
      "a higher minimum",
      { type: "integer", minimum: 1 },
      { type: "integer", minimum: 5 },
      ["input value: minimum 1 → 5"],
    ],
    ["a new minLength", { type: "string" }, { type: "string", minLength: 2 }, ["input value: minLength none → 2"]],
    [
      "a lower maxItems",
      { type: "array", maxItems: 10 },
      { type: "array", maxItems: 5 },
      ["input value: maxItems 10 → 5"],
    ],
    ["a higher maximum", { type: "integer", maximum: 5 }, { type: "integer", maximum: 10 }, []],
    ["a dropped minimum", { type: "integer", minimum: 1 }, { type: "integer" }, []],
    ["a new pattern", { type: "string" }, { type: "string", pattern: "^ch_" }, ["input value: pattern none → ^ch_"]],
    [
      "a changed pattern",
      { type: "string", pattern: "^ch_" },
      { type: "string", pattern: "^py_" },
      ["input value: pattern ^ch_ → ^py_"],
    ],
    [
      "a new type and a new minimum",
      { type: "string" },
      { type: "integer", minimum: 0 },
      ["input value: type string → integer", "input value: minimum none → 0"],
    ],
  ])("reads %s", (_case, served, proposed, details) => {
    expect(valueDiff(served, proposed).breaking).toStrictEqual(
      details.map((detail) => ({ reason: "narrowed_type", detail })),
    );
  });

  it("breaks on each input that becomes required, and notes inputs added and removed", () => {
    const entry = changeOf(
      stripeDiff(
        {
          upstream: {
            create_refund: {
              inputSchema: { type: "object", properties: { charge: { type: "string" }, legacy: { type: "string" } } },
            },
          },
        },
        {
          upstream: {
            create_refund: {
              inputSchema: {
                type: "object",
                properties: {
                  charge: { type: "string" },
                  currency: { type: "string", description: "ISO 4217\nThree letters, lower case." },
                  flag: { type: "boolean", description: "" },
                  tag: {},
                  memo: { type: "string" },
                },
                required: ["charge", "currency", "flag", "ghost", "tag"],
              },
            },
          },
        },
      ),
      "create_refund",
    );
    expect(entry.breaking).toStrictEqual(
      [
        "input charge is now required",
        "new required input: currency (string, ISO 4217)",
        "new required input: flag (boolean)",
        "new required input: ghost (any)",
        "new required input: tag (any)",
      ].map((detail) => ({ reason: "new_required_input", detail })),
    );
    expect(entry.notes).toStrictEqual(["input legacy removed", "input memo added"]);
  });

  it("reads nested objects and array items by their path", () => {
    const lines = (items: Record<string, unknown>) => ({ type: "array", items: { type: "object", ...items } });
    const entry = changeOf(
      stripeDiff(
        {
          upstream: {
            create_refund: {
              inputSchema: {
                type: "object",
                properties: {
                  refund: {
                    type: "object",
                    properties: { lines: lines({ properties: { amount: { type: "integer", minimum: 0 } } }) },
                  },
                },
              },
            },
          },
        },
        {
          upstream: {
            create_refund: {
              inputSchema: {
                type: "object",
                properties: {
                  refund: {
                    type: "object",
                    properties: {
                      lines: lines({
                        properties: { amount: { type: "integer", minimum: 1 }, sku: { type: "string" } },
                        required: ["sku"],
                      }),
                      reason: { type: "string" },
                    },
                    required: ["reason"],
                  },
                },
              },
            },
          },
        },
      ),
      "create_refund",
    );
    expect(entry.breaking).toStrictEqual([
      { reason: "new_required_input", detail: "new required input: refund.reason (string)" },
      { reason: "new_required_input", detail: "new required input: refund.lines[].sku (string)" },
      { reason: "narrowed_type", detail: "input refund.lines[].amount: minimum 0 → 1" },
    ]);
    expect(entry.notes).toStrictEqual([]);
  });
});

// ── Response fields ──────────────────────────────────────────────────────────

interface ChargesSide {
  select: string[];
  /** list_charges' outputSchema. The fixture has none. */
  output: Record<string, unknown> | undefined;
}

/** stripe's list_charges with a select and an outputSchema on each side. */
function chargesDiff(served: ChargesSide, proposed: ChargesSide): Changed {
  const edit = ({ select, output }: ChargesSide): StripeEdit => ({
    tools: { list_charges: { select } },
    upstream: output === undefined ? {} : { list_charges: { outputSchema: output } },
  });
  return changeOf(stripeDiff(edit(served), edit(proposed)), "list_charges");
}

describe("diff reads each response field select names", () => {
  it("breaks when a field select named is gone, on either side's select", () => {
    const entry = chargesDiff(
      {
        select: ["data[].id", "data[].status", "has_more"],
        output: chargesOutput(
          { id: ID, amount: INTEGER, status: { type: "string" } },
          { has_more: { type: "boolean" } },
        ),
      },
      { select: ["data[].id", "data[].status"], output: chargesOutput({ id: ID }) },
    );
    expect(entry.breaking).toStrictEqual([
      { reason: "removed_selected_field", detail: "selected response field removed: data[].status" },
      { reason: "removed_selected_field", detail: "selected response field removed: has_more" },
    ]);
    expect(entry.notes).toStrictEqual(["response field data[].amount removed"]);
  });

  it("notes a new field, and whether select returns it", () => {
    const select = ["data[].id", "meta"];
    const entry = chargesDiff(
      { select, output: chargesOutput({ id: ID }) },
      {
        select,
        output: chargesOutput(
          { id: ID, fee: INTEGER },
          { meta: { type: "object", properties: { request_id: { type: "string" } } } },
        ),
      },
    );
    expect(entry.breaking).toStrictEqual([]);
    expect(entry.notes).toStrictEqual([
      "response field data[].fee added (not in select, not returned)",
      "response field meta added",
    ]);
  });

  it("returns every new field when select names none", () => {
    const entry = chargesDiff(
      { select: [], output: chargesOutput({ id: ID }) },
      { select: [], output: chargesOutput({ id: ID, fee: INTEGER }) },
    );
    expect(entry.notes).toStrictEqual(["response field data[].fee added"]);
  });

  it("notes an output schema added or removed", () => {
    const output = chargesOutput({ id: ID });
    expect(chargesDiff({ select: [], output: undefined }, { select: [], output }).notes).toStrictEqual([
      "output schema added",
    ]);
    expect(chargesDiff({ select: [], output }, { select: [], output: undefined }).notes).toStrictEqual([
      "output schema removed",
    ]);
  });
});

// ── Fallback notes ───────────────────────────────────────────────────────────

describe("diff names what changed when no rule reads it", () => {
  it("names the upstream keys that changed", () => {
    const entry = changeOf(
      stripeDiff({}, { upstream: { create_refund: { annotations: { destructiveHint: true, openWorldHint: true } } } }),
      "create_refund",
    );
    expect(entry).toStrictEqual({
      change: "changed",
      key: "create_refund",
      tool: "stripe__create_refund",
      version: { served: 1, proposed: 1 },
      breaking: [],
      description: undefined,
      notes: ["upstream annotations changed"],
    });
  });

  it("names the definition keys that changed when only tools.toml did", () => {
    const description = "Refund a captured charge. The amount is in cents.";
    const entry = changeOf(stripeDiff({}, { tools: { create_refund: { description } } }), "create_refund");
    expect(entry.version).toStrictEqual({ served: 1, proposed: 2 });
    expect(entry.notes).toStrictEqual(["definition description changed"]);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe("diff refuses sides that do not match", () => {
  it("refuses two servers", () => {
    const stripe = fixtureSide("stripe", toolsToml("stripe"), stripeUpstream());
    const billing = fixtureSide("billing", toolsToml("billing"), billingUpstream());
    expect(() => diff({ served: stripe, proposed: billing, offered: [] })).toThrow(
      "diff compares one server, and its locks and manifests name billing and stripe.",
    );
  });

  it("refuses a lock that pins a tool its manifest lacks", () => {
    const served = fixtureSide("stripe", toolsToml("stripe"), stripeUpstream());
    const proposed = fixtureSide("stripe", toolsToml("stripe"), stripeUpstream(), served);
    const empty = (side: DiffSide): DiffSide => ({ ...side, server: { ...side.server, tools: {} } });
    expect(() => diff({ served, proposed: empty(proposed), offered: [] })).toThrow(
      "The proposed lock pins create_refund, and the proposed manifest has no such tool.",
    );
    expect(() => diff({ served: empty(served), proposed, offered: [] })).toThrow(
      "The served lock pins create_refund, and the served manifest has no such tool.",
    );
  });
});
