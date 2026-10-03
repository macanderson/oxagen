import { describe, expect, it } from "vitest";
import {
  APP_SOURCE_PATTERN,
  computeParity,
  isAppSource,
  parseContract,
  parseV2Tool,
  resolveInvoked,
} from "./check_ui_parity.mjs";

// Two contract fixtures: one declares the "app" layer, one does not.
const CAPS = [
  {
    name: "create_api_key",
    layers: ["api", "mcp", "app"],
    ident: "apiKeyCreate",
  },
  { name: "query_audit_log", layers: ["api", "mcp"], ident: "auditLogQuery" },
  { name: "get_graph_stats", layers: ["api"], ident: "graphStats" },
];
const IDENT_TO_NAME = new Map(CAPS.map((c) => [c.ident, c.name]));
const VALID = new Set(CAPS.map((c) => c.name));

describe("resolveInvoked", () => {
  it("resolves the invoke(<ident>.name, ...) call shape via the ident map", () => {
    const src = `
      const a = await invoke(apiKeyCreate.name, input, ctx);
      const b = await invoke(auditLogQuery.name, input, ctx, { surface: "agent" });
    `;
    const got = resolveInvoked(src, VALID, IDENT_TO_NAME);
    expect(got.has("create_api_key")).toBe(true);
    expect(got.has("query_audit_log")).toBe(true);
    expect(got.size).toBe(2);
  });

  it('resolves the string-literal invoke("name", ...) call shape', () => {
    const src = `await invoke("get_graph_stats", input, ctx);`;
    expect(
      resolveInvoked(src, VALID, IDENT_TO_NAME).has("get_graph_stats"),
    ).toBe(true);
  });

  it("ignores idents/strings that are not registered capabilities", () => {
    const src = `invoke(somethingElse.name, x); invoke("not.a.real.capability", y);`;
    expect(resolveInvoked(src, VALID, IDENT_TO_NAME).size).toBe(0);
  });

  // The regression: the app reads and writes through kernelRead and
  // kernelWrite, not invoke(), so the reverse check saw almost nothing it
  // calls. The Steering page read get_steering_freshness, which declared no
  // app layer, and nothing reported it.
  it("resolves a kernelRead call by the contract key of its request", () => {
    const src = `
      const read = await kernelRead(ctx, {
        contract: graphStats,
        input: {},
        page: "graph",
      });
    `;
    const got = resolveInvoked(src, VALID, IDENT_TO_NAME);
    expect(got).toEqual(new Set(["get_graph_stats"]));
  });

  it("resolves a kernelWrite call by its second argument, typed or not", () => {
    const src = `
      await kernelWrite(ctx, apiKeyCreate, input);
      await kernelWrite<AuditPage>(
        ctx,
        auditLogQuery,
        { cursor },
      );
    `;
    const got = resolveInvoked(src, VALID, IDENT_TO_NAME);
    expect(got).toEqual(new Set(["create_api_key", "query_audit_log"]));
  });

  it("ignores a contract key or kernelWrite argument that names no contract (negative)", () => {
    // Each line puts a registered contract where the resolver must not read
    // one: a type, a third argument, a key that only ends in "contract", a
    // longer function name, and a longer identifier.
    const src = `
      type Call = { contract: ReadContract<I, O>; input: I };
      await kernelWrite(ctx, input, apiKeyCreate);
      const options = { subcontract: graphStats };
      await kernelWriteMany(ctx, auditLogQuery);
      await kernelWrite(ctx, apiKeyCreateV2, input);
    `;
    expect(resolveInvoked(src, VALID, IDENT_TO_NAME).size).toBe(0);
  });
});

// rg picks the files resolveInvoked reads by this pattern, so a call shape it
// misses is a call the fast path never sees. The directory walk reads every
// file and would still find it, and the two paths would disagree.
describe("APP_SOURCE_PATTERN", () => {
  const SHAPES = [
    "await invoke(apiKeyCreate.name, input, ctx);",
    'await invoke("get_graph_stats", input, ctx);',
    "await kernelRead(ctx, { contract: graphStats, input: {} });",
    "await kernelWrite(ctx, apiKeyCreate, input);",
    "await kernelWrite<AuditPage>(ctx, auditLogQuery, { cursor });",
  ];

  it.each(SHAPES)("selects a file that holds %s", (src) => {
    expect(resolveInvoked(src, VALID, IDENT_TO_NAME).size).toBe(1);
    expect(new RegExp(APP_SOURCE_PATTERN).test(src)).toBe(true);
  });

  it("passes over a file that calls no contract (negative)", () => {
    const src = "export const view = (ctx: Ctx) => render(ctx.page);";
    expect(new RegExp(APP_SOURCE_PATTERN).test(src)).toBe(false);
  });
});

describe("isAppSource", () => {
  it("keeps the app's TypeScript and TSX files", () => {
    expect(isAppSource("apps/app/src/data/live/steering.ts")).toBe(true);
    expect(isAppSource("apps/app/src/ui/record-card.tsx")).toBe(true);
  });

  it("drops tests, the probes under src/test/, and other file types", () => {
    expect(isAppSource("apps/app/src/features/x/x.test.tsx")).toBe(false);
    expect(isAppSource("apps/app/src/server/kernel.spec.ts")).toBe(false);
    expect(isAppSource("apps/app/src/test/architecture/probe.ts")).toBe(false);
    expect(isAppSource("apps/app/src/features/steering/view.css")).toBe(false);
  });

  it("reads a Windows path the same as a POSIX one", () => {
    expect(isAppSource("apps\\app\\src\\test\\probe.ts")).toBe(false);
    expect(isAppSource("apps\\app\\src\\server\\kernel.ts")).toBe(true);
  });
});

describe("computeParity — forward gate", () => {
  const pageExists = (p: string) => p === "apps/app/.../real-page.tsx";

  it("flags an app-layer capability with no binding", () => {
    const { forward } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({ capability: "create_api_key" });
    expect(forward[0]!.reason).toContain("no binding");
  });

  it("flags an app-layer binding whose page is missing on disk", () => {
    const bindings = {
      create_api_key: { page: "apps/app/.../ghost.tsx", proof: "x.png" },
    };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward[0]!.reason).toContain("missing on disk");
  });

  it("flags a wired binding that carries no runtime proof", () => {
    const bindings = { create_api_key: { page: "apps/app/.../real-page.tsx" } };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward[0]!.reason).toContain("no runtime `proof`");
  });

  it("passes a fully-wired, proven app-layer capability", () => {
    const bindings = {
      create_api_key: {
        page: "apps/app/.../real-page.tsx",
        proof: "verifications/s/x.png",
      },
    };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(0);
  });
});

describe("computeParity — also, the second page a capability is bound on", () => {
  const pageExists = (p: string) =>
    p === "apps/app/.../real-page.tsx" || p === "apps/app/.../second-page.tsx";
  const primary = {
    page: "apps/app/.../real-page.tsx",
    proof: "apps/app/src/features/x/x.test.tsx",
  };
  const gaps = (also: unknown) =>
    computeParity({
      caps: CAPS,
      bindings: { create_api_key: { ...primary, also } },
      invoked: new Set(),
      pageExists,
    }).forward;

  it("passes a binding whose also entry has a page on disk and a proof", () => {
    expect(
      gaps([
        { page: "apps/app/.../second-page.tsx", proof: "apps/app/b.test.tsx" },
      ]),
    ).toHaveLength(0);
  });

  it("flags an also entry whose page is missing on disk", () => {
    const [gap] = gaps([
      { page: "apps/app/.../ghost.tsx", proof: "apps/app/b.test.tsx" },
    ]);
    expect(gap).toMatchObject({ capability: "create_api_key" });
    expect(gap!.reason).toContain("binding.also[0].page missing on disk");
  });

  it("flags an also entry that carries no runtime proof", () => {
    const [gap] = gaps([{ page: "apps/app/.../second-page.tsx" }]);
    expect(gap!.reason).toContain("binding.also[0] has no runtime `proof`");
  });

  it("reports the index of the failing entry, not the first one", () => {
    const [gap] = gaps([
      { page: "apps/app/.../second-page.tsx", proof: "apps/app/b.test.tsx" },
      { page: "apps/app/.../ghost.tsx", proof: "apps/app/c.test.tsx" },
    ]);
    expect(gap!.reason).toContain("binding.also[1]");
  });

  it("flags a mistyped also rather than skipping it (negative)", () => {
    expect(gaps("apps/app/.../second-page.tsx")[0]!.reason).toContain(
      "binding.also is not an array",
    );
    expect(gaps(["apps/app/.../second-page.tsx"])[0]!.reason).toContain(
      "binding.also[0] is not an object",
    );
  });

  it("judges the primary binding first: a broken primary hides nothing", () => {
    const { forward } = computeParity({
      caps: CAPS,
      bindings: {
        create_api_key: {
          page: "apps/app/.../ghost.tsx",
          proof: "p",
          also: [{ page: "apps/app/.../second-page.tsx", proof: "q" }],
        },
      },
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]!.reason).toContain("binding.page missing on disk");
  });
});

describe("computeParity — ratchet baseline", () => {
  const pageExists = () => false; // every binding.page is missing → gaps

  it("with no baseline, blocking === forward (backward compatible)", () => {
    const { forward, blocking } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(1); // only create_api_key declares 'app'
    expect(blocking).toEqual(forward);
  });

  it("grandfathers a baselined gap: it stays in forward but leaves blocking", () => {
    const baseline = new Set(["create_api_key"]);
    const { forward, blocking } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked: new Set(),
      pageExists,
      baseline,
    });
    expect(forward.map((g) => g.capability)).toContain("create_api_key");
    expect(blocking).toHaveLength(0); // the ratchet suppresses the strict failure
  });

  it("still blocks a NEW gap not present in the baseline", () => {
    // A second app-layer cap with a gap; baseline only grandfathers the first.
    const caps = [
      ...CAPS,
      { name: "list_secrets", layers: ["api", "app"], ident: "listSecrets" },
    ];
    const baseline = new Set(["create_api_key"]);
    const { blocking } = computeParity({
      caps,
      bindings: {},
      invoked: new Set(),
      pageExists,
      baseline,
    });
    expect(blocking.map((g) => g.capability)).toEqual(["list_secrets"]);
  });
});

describe("computeParity — reverse advisory", () => {
  const pageExists = () => true;

  it("flags a capability the app invokes that never declared the app layer", () => {
    const invoked = new Set(["query_audit_log"]);
    const { reverse } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked,
      pageExists,
    });
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({ capability: "query_audit_log" });
    expect(reverse[0]!.reason).toContain("does not declare the 'app' layer");
  });

  it("flags an app-layer, app-invoked capability that has no binding", () => {
    const invoked = new Set(["create_api_key"]);
    const { reverse } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked,
      pageExists,
    });
    expect(
      reverse.some(
        (r) =>
          r.capability === "create_api_key" && r.reason.includes("no binding"),
      ),
    ).toBe(true);
  });

  it("does not flag an app-invoked capability that is fully declared + bound", () => {
    const invoked = new Set(["create_api_key"]);
    const bindings = { create_api_key: { page: "p", proof: "x" } };
    const { reverse } = computeParity({
      caps: CAPS,
      bindings,
      invoked,
      pageExists,
    });
    expect(reverse).toHaveLength(0);
  });
});

describe("parseContract", () => {
  const SRC = [
    "/**",
    " * List the runs.",
    " *",
    " * A person whose record carries no name: `operatorKind` separates them.",
    ' * Historically this read `layers: ["app"]` in prose too.',
    " */",
    "export const runList = registerCapability({",
    '  name: "list_runs",',
    '  layers: ["schema", "api", "mcp", "app"],',
    "});",
    "",
  ].join("\n");

  it("reads the registered name and layers, not a sentence that mentions them", () => {
    // The regression: an unanchored match read `operatorKind` out of the
    // JSDoc above, and --strict then demanded a page for a capability that
    // does not exist.
    expect(parseContract("run.list.ts", SRC)).toEqual({
      file: "run.list.ts",
      name: "list_runs",
      layers: ["schema", "api", "mcp", "app"],
      hasRegister: true,
      ident: "runList",
    });
  });

  it("falls back to the filename when no contract declares a name (negative)", () => {
    const parsed = parseContract("orphan.ts", "// nothing here\n");
    expect(parsed.name).toBe("orphan");
    expect(parsed.hasRegister).toBe(false);
    expect(parsed.layers).toEqual([]);
    expect(parsed.ident).toBeNull();
  });
});

describe("parseV2Tool", () => {
  const SRC = [
    'import { defineTool } from "./_define";',
    "",
    "/** Absorbs `change_member_role`; see `defineTool(` in _define.ts. */",
    "export const setMemberRole = defineTool({",
    '  name: "set_member_role",',
    '  layers: ["api", "docs", "mcp", "unit", "app"],',
    "  absorbs: [",
    '    "change_member_role",',
    '    "remove_org_member",',
    "  ],",
    "  drops: [],",
    "});",
    "",
  ].join("\n");

  it("reads the defineTool call's name, layers and absorbs, wrapped across lines", () => {
    expect(parseV2Tool("set-member-role.ts", SRC)).toEqual({
      file: "set-member-role.ts",
      name: "set_member_role",
      layers: ["api", "docs", "mcp", "unit", "app"],
      absorbs: ["change_member_role", "remove_org_member"],
    });
  });

  it("reads no layers from a descriptor that takes them from its live contract", () => {
    const src = [
      "export const importTools = defineTool({",
      "  name: live.name,",
      "  layers: live.layers,",
      '  absorbs: ["list_tool_declarations"],',
      "});",
    ].join("\n");
    expect(parseV2Tool("import-tools.ts", src)).toMatchObject({
      name: "import-tools",
      layers: [],
      absorbs: ["list_tool_declarations"],
    });
  });

  it("returns null for a file that defines no tool (negative)", () => {
    expect(parseV2Tool("_define.ts", "export function defineTool<T>(t: T) {}\n")).toBeNull();
  });
});

// The v2 descriptors are not registered until cutover, so a v1 contract that
// declares "app" carries each one's "app" layer. Before #2949 the checker read
// none of contracts/v2, and four descriptors promised a page nothing carried.
describe("computeParity — v2 descriptors", () => {
  const pageExists = () => true;
  const V1 = [
    { name: "change_member_role", layers: ["api", "app"], ident: "a" },
    { name: "remove_org_member", layers: ["api", "app"], ident: "b" },
    { name: "delete_memory", layers: ["api"], ident: "c" },
    { name: "erase_data", layers: ["api", "mcp"], ident: "d" },
    { name: "export_data", layers: ["api", "app"], ident: "e" },
  ];
  const BOUND = {
    change_member_role: { page: "p.tsx", proof: "p.test.tsx" },
    remove_org_member: { page: "p.tsx", proof: "p.test.tsx" },
    export_data: { page: "p.tsx", proof: "p.test.tsx" },
  };
  const tool = (name: string, layers: string[], absorbs: string[]) => ({
    file: `${name.replace(/_/g, "-")}.ts`,
    name,
    layers,
    absorbs,
  });

  it("passes a tool an absorbed app-layer contract carries", () => {
    const { forward } = computeParity({
      caps: V1,
      bindings: BOUND,
      invoked: new Set(),
      pageExists,
      v2Tools: [
        tool("set_member_role", ["api", "app"], [
          "change_member_role",
          "remove_org_member",
        ]),
      ],
    });
    expect(forward).toEqual([]);
  });

  it("passes a tool the live contract of its own name carries", () => {
    const { forward } = computeParity({
      caps: V1,
      bindings: BOUND,
      invoked: new Set(),
      pageExists,
      v2Tools: [tool("export_data", ["api", "app"], ["export_data"])],
    });
    expect(forward).toEqual([]);
  });

  it("flags a tool that declares app when nothing it names does (negative)", () => {
    const { forward, blocking } = computeParity({
      caps: V1,
      bindings: BOUND,
      invoked: new Set(),
      pageExists,
      v2Tools: [
        tool("retract_record", ["api", "app"], ["delete_memory"]),
        tool("erase_data", ["api", "app"], ["erase_data"]),
      ],
    });
    expect(forward.map((g) => g.capability)).toEqual([
      "v2:retract_record",
      "v2:erase_data",
    ]);
    expect(forward[0]?.reason).toContain("contracts/v2/retract-record.ts");
    expect(blocking).toEqual(forward);
  });

  it("skips a tool that declares no app layer", () => {
    const { forward } = computeParity({
      caps: V1,
      bindings: BOUND,
      invoked: new Set(),
      pageExists,
      v2Tools: [tool("retract_record", ["api"], ["delete_memory"])],
    });
    expect(forward).toEqual([]);
  });

  it("names a gap v2:<name>, so a v1 name in the baseline does not hide it", () => {
    const { blocking } = computeParity({
      caps: V1,
      bindings: BOUND,
      invoked: new Set(),
      pageExists,
      baseline: new Set(["erase_data"]),
      v2Tools: [tool("erase_data", ["api", "app"], ["erase_data"])],
    });
    expect(blocking.map((g) => g.capability)).toEqual(["v2:erase_data"]);
  });
});
