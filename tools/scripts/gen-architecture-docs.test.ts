import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROOT,
  build,
  canonicalJson,
  readOrNull,
} from "./gen-architecture-docs";
import {
  collectAdrs,
  collectApiRoutes,
  collectCaddy,
  collectCapabilities,
  collectCli,
  collectClickHouse,
  collectCompose,
  collectInngest,
  collectMcpTools,
  collectPostgresEdges,
  collectWorkflows,
  collectWorkspace,
  type Capability,
  type StorageManifest,
} from "./lib/archdocs/collect";
import { flows, verifyRefs } from "./lib/archdocs/flows";
import {
  layer,
  layoutDag,
  renderChain,
  renderDag,
  renderErd,
  renderGrid,
  renderSequence,
  transitiveReduce,
  wrap,
} from "./lib/archdocs/svg";

const tmp: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "archdocs-"));
  tmp.push(d);
  return d;
}
function file(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── svg ──────────────────────────────────────────────────────────────────────

describe("svg layout", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id, label: id }));

  it("layers by longest path and breaks cycles on the back edge", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
      { from: "c", to: "a" },
    ];
    const { layers, backEdges } = layer(nodes, edges);
    expect(layers.get("a")).toBe(0);
    expect(layers.get("b")).toBe(1);
    expect(layers.get("c")).toBe(2);
    expect([...backEdges].map((e) => `${e.from}>${e.to}`)).toEqual(["c>a"]);
  });

  it("transitive reduction drops the edge a longer path implies, and only that edge", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
      { from: "a", to: "d" },
    ];
    expect(
      transitiveReduce(nodes, edges).map((e) => `${e.from}>${e.to}`),
    ).toEqual(["a>b", "b>c", "a>d"]);
  });

  it("places every node without overlap inside the viewBox", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    const { placed, w, h } = layoutDag(nodes, edges, { label: "t" });
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(w);
      expect(p.y + p.h).toBeLessThanOrEqual(h);
    }
    const b = placed.find((p) => p.id === "b")!;
    const c = placed.find((p) => p.id === "c")!;
    expect(b.y).toBe(c.y);
    expect(b.x + b.w <= c.x || c.x + c.w <= b.x).toBe(true);
  });

  it("renders deterministic, self-contained SVG with arrow markers and no script", () => {
    const edges = [{ from: "a", to: "b", label: "writes" }];
    const one = renderDag(nodes.slice(0, 2), edges, { label: "two boxes" });
    const two = renderDag(nodes.slice(0, 2), edges, { label: "two boxes" });
    expect(one).toBe(two);
    expect(one).toContain('role="img"');
    expect(one).toContain('aria-label="two boxes"');
    expect(one).toContain('marker-end="url(#arrow)"');
    expect(one).toContain(">writes<");
    expect(one).not.toMatch(/<script|<style|<foreignObject/);
    expect(one).toContain("currentColor");
  });

  it("wraps labels by measured width", () => {
    const lines = wrap("one two three four five six", 60);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.join(" ")).toBe("one two three four five six");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(9);
    expect(wrap("short", 500)).toEqual(["short"]);
  });

  it("erd draws declared edges solid, inferred edges dashed, and lists external references in the footer", () => {
    const svg = renderErd(
      [
        {
          id: "s.a",
          name: "a",
          columns: [{ name: "id", type: "uuid", pk: true }],
          badge: "RLS standard",
        },
        {
          id: "s.b",
          name: "b",
          columns: [
            { name: "a_id", type: "uuid", fk: "s.a" },
            { name: "org_id", type: "uuid" },
          ],
        },
      ],
      [
        { from: "s.b", fromColumn: "a_id", to: "s.a" },
        {
          from: "s.b",
          fromColumn: "org_id",
          to: "o.organizations",
          inferred: true,
        },
      ],
      "erd",
      { externalLabel: (id) => id },
    );
    expect(svg).toContain("◆ id");
    expect(svg).toContain("→ a_id");
    expect(svg).toContain("org_id ↗ o.organizations");
    expect(svg).toContain("RLS standard");
    expect(svg).toContain('data-from="s.b" data-to="s.a"');
    expect(svg).not.toContain('data-to="o.organizations"');
  });

  it("sequence numbers steps and draws notes across the width", () => {
    const svg = renderSequence(
      [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
      [
        { from: "x", to: "y", label: "call", detail: "fn()" },
        { from: "y", to: "y", label: "self" },
        { from: "x", to: "x", label: "a note", note: true },
      ],
      "seq",
    );
    expect(svg).toContain(">1<");
    expect(svg).toContain(">2<");
    expect(svg).toContain(">fn()<");
    expect(svg).toContain('class="note"');
  });

  it("grid routes with one bend and wraps long labels into the gap; chain draws exits", () => {
    const grid = renderGrid(
      [
        { id: "a", label: "A", col: 0, row: 0 },
        { id: "b", label: "B", col: 1, row: 1 },
      ],
      [
        {
          from: "a",
          to: "b",
          label: "a fairly long edge label that must wrap",
        },
      ],
      [{ label: "group", col: 0, row: 0, colspan: 2, rowspan: 2 }],
      "grid",
    );
    expect(svg(grid).match(/class="elabel"/g)!.length).toBeGreaterThan(1);
    expect(grid).toContain(">GROUP<");
    const chain = renderChain(
      [
        { label: "one" },
        { label: "two", exit: "denied" },
        { label: "three", accent: true },
      ],
      "chain",
      { perRow: 2 },
    );
    expect(chain).toContain(">denied<");
    expect(chain).toContain("var(--accent");
  });

  it("chain boxes grow to fit their longest sub, so no text spills past its box", () => {
    const widthOf = (svgText: string): number =>
      Number(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)"/.exec(svgText)![1]);
    const short = renderChain([{ label: "a", sub: "b" }], "c");
    const sub = "entity_type_mappings × delivery_config";
    const long = renderChain([{ label: "a", sub }, { label: "b" }], "c");
    expect(widthOf(short)).toBe(150);
    expect(widthOf(long)).toBeGreaterThanOrEqual(sub.length * 6);
  });
});

const svg = (s: string): string => s;

// ── collectors ───────────────────────────────────────────────────────────────

describe("collectors", () => {
  it("reads workspace packages with workspace deps only", () => {
    const root = scratch();
    file(
      root,
      "apps/x/package.json",
      JSON.stringify({
        name: "@oxagen/x",
        dependencies: { "@oxagen/y": "workspace:*", zod: "3.0.0" },
      }),
    );
    file(
      root,
      "packages/y/package.json",
      JSON.stringify({ name: "@oxagen/y", description: "y" }),
    );
    const ws = collectWorkspace(root);
    expect(ws.map((p) => [p.name, p.kind, p.deps, p.externalDeps])).toEqual([
      ["@oxagen/x", "app", ["@oxagen/y"], 1],
      ["@oxagen/y", "package", [], 0],
    ]);
  });

  it("replays ClickHouse schema then migrations, honouring drops and later definitions", () => {
    const root = scratch();
    file(
      root,
      "packages/telemetry/src/schema.sql",
      "CREATE TABLE IF NOT EXISTS a (\n  id UUID,\n  ts DateTime64(3) CODEC(Delta, ZSTD)\n) ENGINE = MergeTree ORDER BY (id, ts);\nCREATE TABLE IF NOT EXISTS dead (x String) ENGINE = MergeTree ORDER BY x;",
    );
    file(
      root,
      "packages/telemetry/src/migrations/0001_x.sql",
      "-- comment\nDROP TABLE IF EXISTS dead;\nCREATE TABLE IF NOT EXISTS b (\n  org_id UUID,\n  n Nullable(Int64) DEFAULT 0\n) ENGINE = ReplacingMergeTree(ts)\nORDER BY (org_id)\nTTL ts + INTERVAL 30 DAY;",
    );
    const t = collectClickHouse(root);
    expect(t.map((x) => x.name)).toEqual(["a", "b"]);
    expect(t[0]!.columns).toEqual([
      { name: "id", type: "UUID" },
      { name: "ts", type: "DateTime64(3)" },
    ]);
    expect(t[0]!.orderBy).toBe("(id, ts)");
    expect(t[1]!.engine).toBe("ReplacingMergeTree(ts)");
    expect(t[1]!.columns[1]).toEqual({ name: "n", type: "Nullable(Int64)" });
    expect(t[1]!.definedIn).toBe(
      "packages/telemetry/src/migrations/0001_x.sql",
    );
  });

  it("enumerates Hono routes with the mount prefix, tier and contract", () => {
    const root = scratch();
    file(
      root,
      "apps/api/src/app.ts",
      [
        'import { fooRoute } from "./routes/v1/agent.foo";',
        'import { pubRoute } from "./routes/health";',
        'app.use("*", requestLogger);',
        'app.route("/health", pubRoute);',
        "const orgScoped = new Hono<AppEnv>();",
        'orgScoped.use("*", authMiddleware, orgMiddleware, workspaceMiddleware);',
        'orgScoped.route("/agent/foo", fooRoute);',
        'app.route("/v1/:org_slug/:workspace_slug", orgScoped);',
      ].join("\n"),
    );
    file(
      root,
      "apps/api/src/routes/v1/agent.foo.ts",
      'import { agentFoo } from "@oxagen/oxagen/contracts/agent.foo";\nfooRoute.get("/:id", async (c) => invoke(agentFoo.name, {}, ctx));\nfooRoute.post("/", async (c) => invoke(agentFoo.name, {}, ctx));',
    );
    file(
      root,
      "apps/api/src/routes/health.ts",
      'pubRoute.get("/", (c) => c.text("ok"));',
    );
    const caps: Capability[] = [
      {
        name: "get_foo",
        file: "agent.foo.ts",
        domain: "agent",
        mode: "sync",
        surfaces: ["api"],
        layers: {},
      },
    ];
    const { routes, tiers } = collectApiRoutes(root, caps);
    expect(
      routes.map(
        (r) => `${r.method} ${r.path} [${r.tier}] ${r.capability ?? "-"}`,
      ),
    ).toEqual([
      "POST /v1/:org_slug/:workspace_slug/agent/foo [org+workspace] get_foo",
      "GET /v1/:org_slug/:workspace_slug/agent/foo/:id [org+workspace] get_foo",
      "GET /health [public] -",
    ]);
    expect(tiers["org+workspace"]).toEqual([
      "* → authMiddleware, orgMiddleware, workspaceMiddleware",
    ]);
  });

  it("reads Inngest ids, triggers, crons and sent events from function sources", () => {
    const root = scratch();
    file(
      root,
      "packages/inngest-functions/src/functions/a.b.ts",
      'export const [ab] = createFunction({ id: "a.b", retries: 3 }, { event: "a/b.requested" }, async ({ step }) => { await inngest.send({ name: "a/b.done", data: {} }); });',
    );
    file(
      root,
      "packages/inngest-functions/src/functions/c.ts",
      'export const [c] = createFunction({ id: "c" }, { cron: "0 4 * * *" }, async () => {});',
    );
    file(root, "packages/inngest-functions/src/functions/c.test.ts", "ignored");
    file(
      root,
      "packages/inngest-functions/src/functions.ts",
      "export const functions: any[] = [\n  ab,\n  c,\n];\n",
    );
    const fns = collectInngest(root);
    expect(fns).toEqual([
      {
        id: "a.b",
        file: "packages/inngest-functions/src/functions/a.b.ts",
        triggers: ["a/b.requested"],
        cron: undefined,
        sends: ["a/b.done"],
        retries: 3,
      },
      {
        id: "c",
        file: "packages/inngest-functions/src/functions/c.ts",
        triggers: [],
        cron: "0 4 * * *",
        sends: [],
        retries: undefined,
      },
    ]);
  });

  it("reads only served Inngest functions, one row per declaration, resolving event constants", () => {
    const root = scratch();
    file(
      root,
      "packages/inngest-functions/src/events.ts",
      'export const SHARED_EVENT = "shared/happened";\n',
    );
    file(
      root,
      "packages/inngest-functions/src/functions/two.ts",
      [
        'import { SHARED_EVENT } from "../events";',
        'export const LOCAL_EVENT = "local/requested";',
        'export const [first, firstOnFailure] = createFunction({ id: "two.first" }, { event: LOCAL_EVENT }, async () => {});',
        'export const [second] = createFunction({ id: "two.second" }, { cron: "*/5 * * * *" }, async ({ step }) => { await step.sendEvent("x", { name: SHARED_EVENT, data: {} }); });',
      ].join("\n"),
    );
    file(
      root,
      "packages/inngest-functions/src/functions/unserved.ts",
      'export const [unserved] = createFunction({ id: "unserved" }, { event: "u/v" }, async () => {});',
    );
    file(
      root,
      "packages/inngest-functions/src/functions.ts",
      "export const functions: any[] = [\n  first,\n  firstOnFailure,\n  second,\n];\n",
    );
    expect(
      collectInngest(root).map((f) => [f.id, f.triggers, f.cron, f.sends]),
    ).toEqual([
      ["two.first", ["local/requested"], undefined, []],
      ["two.second", [], "*/5 * * * *", ["shared/happened"]],
    ]);
  });

  it("reads a block-style on: whose first trigger is on the next line", () => {
    const root = scratch();
    file(
      root,
      ".github/workflows/p.yml",
      "name: P\non:\n  pull_request:\n  merge_group:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n",
    );
    expect(collectWorkflows(root)[0]!.triggers).toEqual([
      "pull_request",
      "merge_group",
      "push",
    ]);
  });

  it("binds handlers registered with either lazy-import shape", () => {
    const root = scratch();
    file(
      root,
      "packages/oxagen/capabilities.manifest.json",
      JSON.stringify({
        capabilities: [
          { name: "get_a", domain: "d", surfaces: ["api"] },
          { name: "get_b", domain: "d", surfaces: ["api"] },
        ],
      }),
    );
    file(
      root,
      "packages/handlers/src/register.ts",
      [
        'registerHandler("get_a", async () => (await import("./a.get")).handler);',
        'registerHandler("get_b", () =>',
        '  import("./b.get").then((m) => m.handler),',
        ");",
      ].join("\n"),
    );
    expect(
      collectCapabilities(root).map((c) => [c.name, c.handlerFile]),
    ).toEqual([
      ["get_a", "packages/handlers/src/a.get.ts"],
      ["get_b", "packages/handlers/src/b.get.ts"],
    ]);
  });

  it("leaves _-prefixed helper files out of the MCP tool list", () => {
    const root = scratch();
    file(root, "apps/mcp/src/tools/get_a.ts", "");
    file(root, "apps/mcp/src/tools/_schema-test-helpers.ts", "");
    file(root, "apps/mcp/src/tools/get_a.test.ts", "");
    expect(collectMcpTools(root)).toEqual(["get_a"]);
  });

  it("parses workflow names, triggers (inline, block, list, commented) and job needs", () => {
    const root = scratch();
    file(
      root,
      ".github/workflows/a.yml",
      "name: A\non:\n  # why\n  push:\n    branches: [main]\n  workflow_dispatch: {}\njobs:\n  build:\n    runs-on: x\n  deploy:\n    name: deploy ${{ matrix.s }}\n    needs: [build]\n",
    );
    file(
      root,
      ".github/workflows/b.yml",
      "name: B\non: [push, pull_request]\njobs:\n  only:\n    runs-on: x\n",
    );
    file(
      root,
      ".github/workflows/c.yml",
      "name: C\non: workflow_call # reusable\n",
    );
    const w = collectWorkflows(root);
    expect(w.map((x) => [x.name, x.triggers])).toEqual([
      ["A", ["push", "workflow_dispatch"]],
      ["B", ["push", "pull_request"]],
      ["C", ["workflow_call"]],
    ]);
    expect(w[0]!.jobs).toEqual([
      { id: "build", needs: [] },
      { id: "deploy", name: "deploy ${{ matrix.s }}", needs: ["build"] },
    ]);
  });

  it("parses ADR headers in their several shapes and maps epics from the README", () => {
    const root = scratch();
    file(
      root,
      "docs/adr/README.md",
      "# ADRs\n\n## Foundations epic\n\n- [ADR-001](./x.md) — x\n\n## Not yet filed under an epic\n\n- [ADR-002](./y.md) — y\n",
    );
    file(
      root,
      "docs/adr/ADR-001-x.md",
      "# ADR-001: X\n\n**Status:** Accepted (2026-06-27)\n",
    );
    file(
      root,
      "docs/adr/ADR-002-y.md",
      "# ADR-002: Y\n\nDate: 2026-07-14 · Status: Accepted · Scope: app\n",
    );
    file(
      root,
      "docs/adr/ADR-003-z.md",
      "# ADR-003: Z\n\n- Status: superseded by ADR-004\n- Date: 2026-08-01\n",
    );
    file(
      root,
      "docs/adr/ADR-004-w.md",
      "# ADR-004: W\n\n- **Status:** Accepted; **decision 3 superseded by ADR-009**\n",
    );
    file(
      root,
      "docs/adr/ADR-005-v.md",
      "# ADR-005: V\n\n## Status\n\nProposed\n",
    );
    file(
      root,
      "docs/adr/ADR-006-u.md",
      "# ADR-006: U\n\nStatus: Accepted for implementation. Production application is separate.\n",
    );
    expect(
      collectAdrs(root).map((a) => [
        a.number,
        a.title,
        a.status,
        a.date,
        a.epic,
      ]),
    ).toEqual([
      [1, "X", "Accepted", "2026-06-27", "Foundations"],
      [2, "Y", "Accepted", "2026-07-14", "Unfiled"],
      [3, "Z", "Superseded by ADR-004", "2026-08-01", "Unfiled"],
      [4, "W", "Accepted", "", "Unfiled"],
      [5, "V", "Proposed", "", "Unfiled"],
      [6, "U", "Accepted", "", "Unfiled"],
    ]);
  });

  it("reads Caddy host routes and compose images; nests CLI commands by their parent variable", () => {
    const root = scratch();
    file(
      root,
      "infra/tools/caddy/Caddyfile.alb",
      ":80 {\n route {\n  @api host api.example\n  handle @api {\n   encode gzip\n   reverse_proxy 127.0.0.1:4000\n  }\n }\n}\n",
    );
    file(
      root,
      "docker-compose.dev.yml",
      'services:\n  postgres:\n    image: postgres:16\n    ports: ["5433:5432"]\nvolumes:\n  data:\n',
    );
    file(
      root,
      "apps/cli/src/program.ts",
      'function addWrap(parent: Command): void {\n  parent\n    .command("verify")\n    .description("Check the chain");\n}\nretiredCommand("pr", "PR watching");\nprogram\n  .command("cost")\n  .description("Project cost");\nconst budgetCmd = program\n  .command("budget")\n  .description("Ceilings");\nbudgetCmd\n  .command("show")\n  .description("Show them");\nconst old = program\n  .command("old", { hidden: true })\n  .description("Deprecated");\naddWrap(old);\n',
    );
    expect(collectCaddy(root)).toEqual([{ host: "api.example", port: 4000 }]);
    expect(collectCompose(root)).toEqual([
      { name: "postgres", image: "postgres:16" },
    ]);
    expect(collectCli(root)).toEqual([
      { path: "budget", description: "Ceilings" },
      { path: "budget:show", description: "Show them" },
      { path: "cost", description: "Project cost" },
      { path: "old", description: "Deprecated" },
      { path: "old:verify", description: "Check the chain" },
      { path: "pr", description: "PR watching", retired: true },
    ]);
  });

  it("merges declared references with relations.ts edges, mapping export names to table ids", () => {
    const root = scratch();
    file(
      root,
      "packages/database/src/schema/_schemas.ts",
      'export const orgSchema = pgSchema("org");\nexport const wsSchema = pgSchema("workspace");\n',
    );
    file(
      root,
      "packages/database/src/schema/org.ts",
      'export const organizations = orgSchema.table("organizations", {});\n',
    );
    file(
      root,
      "packages/database/src/schema/workspace.ts",
      'export const workspaces = wsSchema.table("workspaces", {});\nexport const workspaceUsers = wsSchema.table("workspace_users", {});\n',
    );
    file(
      root,
      "packages/database/src/relations.ts",
      "export const r = relations(workspaces, ({ one }) => ({\n  org: one(organizations, {\n    fields: [workspaces.orgId],\n    references: [organizations.id],\n  }),\n}));\n",
    );
    const manifest = {
      tables: [
        {
          id: "postgres:org.organizations",
          store: "postgres",
          columns: [
            { name: "id", type: "uuid", nullable: false, primaryKey: true },
          ],
        },
        {
          id: "postgres:workspace.workspaces",
          store: "postgres",
          columns: [
            {
              name: "org_id",
              type: "uuid",
              nullable: false,
              primaryKey: false,
            },
          ],
        },
        {
          id: "postgres:workspace.workspace_users",
          store: "postgres",
          columns: [
            {
              name: "workspace_id",
              type: "uuid",
              nullable: false,
              primaryKey: false,
              references: "postgres:workspace.workspaces",
            },
          ],
        },
      ],
    } as unknown as StorageManifest;
    expect(collectPostgresEdges(root, manifest)).toEqual([
      {
        from: "postgres:workspace.workspace_users",
        fromColumn: "workspace_id",
        to: "postgres:workspace.workspaces",
        source: "references",
      },
      {
        from: "postgres:workspace.workspaces",
        fromColumn: "org_id",
        to: "postgres:org.organizations",
        source: "relations",
      },
    ]);
  });
});

// ── flows: the ref guard ─────────────────────────────────────────────────────

describe("curated flows", () => {
  it("every flow cites at least one source and every ref resolves in this tree", () => {
    for (const f of flows) expect(f.refs.length, f.id).toBeGreaterThan(0);
    expect(verifyRefs(ROOT, readOrNull)).toEqual([]);
  });

  it("verifyRefs names the missing file and the missing symbol", () => {
    const fake = (p: string): string | null =>
      p.endsWith("kernel.ts") ? "nothing here" : null;
    const problems = verifyRefs("/r", fake);
    expect(problems.some((p) => /missing file/.test(p))).toBe(true);
    expect(
      problems.some((p) => /symbol _invokeCoreInner not found/.test(p)),
    ).toBe(true);
  });
});

// ── the build ────────────────────────────────────────────────────────────────

describe("build", () => {
  it("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }], a: 1 })).toBe(
      '{\n "a": 1,\n "b": [\n  {\n   "a": 2,\n   "z": 1\n  }\n ]\n}\n',
    );
  });

  it(
    "builds the atlas from the real tree deterministically",
    { timeout: 120_000 },
    async () => {
      const first = await build(ROOT);
      const second = await build(ROOT);
      expect(first.html).toBe(second.html);
      expect(first.json).toBe(second.json);
      expect(first.html.startsWith("<!doctype html>")).toBe(true);
      expect(first.html).toContain("<title>Oxagen Architecture Atlas</title>");
      expect(first.html).not.toMatch(/\b20\d\d-\d\d-\d\dT/); // no build timestamps
      for (const f of flows) expect(first.html).toContain(`id="${f.id}"`);
      expect(first.model.capabilities.length).toBeGreaterThan(100);
      expect(
        first.model.apiRoutes.filter((r) => r.capability).length /
          first.model.apiRoutes.length,
      ).toBeGreaterThan(0.85);
    },
  );

  it("the generated output is not tracked, so a moving main can never make it stale", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(ignore).toContain("apps/docs/public/architecture/");
    const docsPkg = JSON.parse(
      readFileSync(join(ROOT, "apps/docs/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(docsPkg.scripts.prebuild).toContain("docs:architecture");
  });
});
