/**
 * Renders the architecture atlas: one self-contained HTML page built from the
 * collected model (generated figures and tables) and the curated flows.
 *
 * No timestamps, no random ids, no environment reads: the page is a pure
 * function of the model so `--check` can byte-compare it.
 */
import type { Model, Capability, ApiRoute } from "./collect";
import { flows, type Flow } from "./flows";
import {
  esc,
  renderChain,
  renderDag,
  renderErd,
  renderGrid,
  renderSequence,
  type DagEdge,
  type DagNode,
  type ErdEdge,
  type ErdTable,
  type GridEdge,
  type GridNode,
} from "./svg";

interface Section {
  id: string;
  title: string;
  lede: string;
  body: string;
}

const short = (name: string): string => name.replace(/^@oxagen\//, "");

function figure(
  id: string,
  title: string,
  claim: string,
  svg: string,
  notes: string[] = [],
  refs: string[] = [],
): string {
  return (
    `<figure id="${esc(id)}" class="figure">` +
    `<h3>${esc(title)}</h3>` +
    `<div class="figwrap">${svg}</div>` +
    `<figcaption>${esc(claim)}</figcaption>` +
    (notes.length
      ? `<ul class="notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>`
      : "") +
    (refs.length
      ? `<details class="refs"><summary>Source refs (${refs.length}, verified at build)</summary><ul>${refs.map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul></details>`
      : "") +
    `</figure>`
  );
}

function renderFlow(f: Flow): string {
  let svg = "";
  if (f.kind === "sequence") svg = renderSequence(f.lanes, f.steps, f.claim);
  else if (f.kind === "chain")
    svg = renderChain(f.steps, f.claim, { perRow: f.perRow });
  else if (f.kind === "grid")
    svg = renderGrid(f.nodes, f.edges, f.groups, f.claim, {
      cellW: f.cellW,
      cellH: f.cellH,
    });
  else
    svg = renderDag(f.nodes, f.edges, {
      label: f.claim,
      direction: f.direction,
      nodeGapY: 70,
      minNodeW: 120,
    });
  return figure(f.id, f.title, f.claim, svg, f.notes, f.refs);
}

function table(
  headers: string[],
  rows: string[][],
  opts: { cls?: string; filter?: boolean; id?: string } = {},
): string {
  const id = opts.id ?? "";
  return (
    (opts.filter
      ? `<div class="filter"><label for="${id}-q">Filter</label><input id="${id}-q" type="search" data-filter="${id}" placeholder="type to filter ${rows.length} rows"><span class="count" data-count="${id}">${rows.length}</span></div>`
      : "") +
    `<div class="tw"><table id="${id}" class="${opts.cls ?? ""}"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>` +
    rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("") +
    `</tbody></table></div>`
  );
}

const code = (s: string): string => `<code>${esc(s)}</code>`;
const n = (v: number): string => `<span class="num">${v}</span>`;

const flowsIn = (section: string): string =>
  flows
    .filter((f) => f.section === section)
    .map(renderFlow)
    .join("");

// ─────────────────────────────────────────────────────────────────────────────

function overview(m: Model): Section {
  const apps = m.packages.filter((p) => p.kind === "app");
  const pkgs = m.packages.filter((p) => p.kind === "package");
  const pg = m.manifest.tables.filter((t) => t.store === "postgres");
  const hostFor = (name: string): string | undefined =>
    m.caddy.find((c) =>
      c.host.startsWith(`${short(name).replace(/-v2$/, "")}.`),
    )?.host;
  const nodes: GridNode[] = [
    { id: "browser", label: "Browser", col: 0, row: 0, kind: "actor" },
    {
      id: "cli",
      label: "oxagen CLI",
      sub: `${m.cli.filter((c) => !c.retired).length} commands`,
      col: 0,
      row: 1,
      kind: "actor",
    },
    {
      id: "mcpc",
      label: "MCP client",
      sub: "Claude Desktop · any MCP client",
      col: 0,
      row: 2,
      kind: "actor",
    },
    {
      id: "agents",
      label: "External agents",
      sub: "Claude Code · Codex · Cursor · Stella",
      col: 0,
      row: 3,
      kind: "actor",
    },
    {
      id: "app",
      label: "apps/app",
      sub: hostFor("@oxagen/app") ?? "Next.js 16",
      col: 1,
      row: 0,
    },
    {
      id: "api",
      label: "apps/api",
      sub: `${hostFor("@oxagen/api") ?? "Hono"} · ${m.apiRoutes.length} routes`,
      col: 1,
      row: 1,
      accent: true,
    },
    {
      id: "mcp",
      label: "apps/mcp",
      sub: `${hostFor("@oxagen/mcp") ?? "xmcp"} · ${m.mcpTools.length} tools`,
      col: 1,
      row: 2,
    },
    {
      id: "kernel",
      label: "capability kernel",
      sub: `${m.capabilities.length} contracts · one invoke()`,
      col: 2,
      row: 1,
      accent: true,
    },
    {
      id: "inngest",
      label: "Inngest",
      sub: `${m.inngest.length} functions`,
      col: 2,
      row: 3,
      kind: "external",
    },
    {
      id: "pg",
      label: "Postgres",
      sub: `${pg.length} tables · ${m.pgSchemas.length} schemas · RLS`,
      col: 3,
      row: 0,
      kind: "store",
    },
    {
      id: "neo4j",
      label: "Neo4j",
      sub: `${m.manifest.tables.filter((t) => t.store === "neo4j").length} labels · vector`,
      col: 3,
      row: 1,
      kind: "store",
    },
    {
      id: "ch",
      label: "ClickHouse",
      sub: `${m.clickhouse.length} tables · append-only`,
      col: 3,
      row: 2,
      kind: "store",
    },
    {
      id: "blob",
      label: "Blob",
      sub: "avatars · evidence · generated assets",
      col: 3,
      row: 3,
      kind: "store",
    },
    {
      id: "stella",
      label: "stella-serve",
      sub: "model engine, loopback",
      col: 2,
      row: 0,
      kind: "external",
    },
    {
      id: "stripe",
      label: "Stripe",
      sub: "webhooks in · nothing re-billed",
      col: 2,
      row: 2,
      kind: "external",
    },
  ];
  const edges: GridEdge[] = [
    { from: "browser", to: "app", label: "HTTPS" },
    { from: "cli", to: "api", label: "REST, ox_ key" },
    { from: "mcpc", to: "mcp", label: "streamable HTTP" },
    {
      from: "agents",
      to: "api",
      label: "/v1/tacho · /v1/telemetry",
      route: "h",
    },
    { from: "app", to: "kernel", label: "invoke() in process" },
    { from: "api", to: "kernel", label: "invoke()" },
    { from: "mcp", to: "kernel", label: "invoke()", route: "h" },
    { from: "kernel", to: "stella", label: "governed turn", route: "v" },
    { from: "kernel", to: "pg", label: "withTenantDb" },
    { from: "kernel", to: "neo4j", label: "scopedSession" },
    { from: "kernel", to: "ch", label: "audit · usage · tool calls" },
    {
      from: "stripe",
      to: "api",
      label: "/webhooks/stripe",
      style: { dashed: true },
    },
    { from: "inngest", to: "kernel", label: "background jobs", route: "v" },
    { from: "inngest", to: "blob", label: "exports" },
  ];
  const svg = renderGrid(
    nodes,
    edges,
    [
      {
        label: "govern · ground · explain · meter · rate",
        col: 1,
        row: 0,
        colspan: 2,
        rowspan: 4,
      },
    ],
    "System context: every client surface calls the capability kernel through invoke().",
    { cellW: 158 },
  );
  const counts: [string, number, string][] = [
    ["Apps", apps.length, "#workspace"],
    ["Packages", pkgs.length, "#workspace"],
    ["Capability contracts", m.capabilities.length, "#kernel"],
    ["API routes", m.apiRoutes.length, "#request"],
    ["MCP tools", m.mcpTools.length, "#surfaces"],
    ["Postgres tables", pg.length, "#datastores"],
    ["ClickHouse tables", m.clickhouse.length, "#clickhouse"],
    [
      "Neo4j labels",
      m.manifest.tables.filter((t) => t.store === "neo4j").length,
      "#neo4j",
    ],
    ["Inngest functions", m.inngest.length, "#jobs"],
    ["Environment variables", m.env.length, "#config"],
    ["GitHub workflows", m.workflows.length, "#deploy"],
    ["ADRs", m.adrs.length, "#decisions"],
  ];
  const tiles = `<div class="tiles">${counts.map(([l, v, h]) => `<a class="tile" href="${h}"><span class="v">${v}</span><span class="l">${l}</span></a>`).join("")}</div>`;
  return {
    id: "overview",
    title: "Overview",
    lede: "Oxagen governs agents; it does not run them. Every client surface calls one capability kernel through invoke(), and the kernel is the normal path to the stores.",
    body:
      tiles +
      figure(
        "system-context",
        "System context",
        "Client surfaces reach the stores through the capability kernel. The exceptions are inbound webhooks (Stripe, GitHub, connectors), usage telemetry intake, CLI token exchange and the app's pre-tenant lookups. stella-serve, Stripe and Inngest sit outside the kernel.",
        svg,
        [
          "The web app and the MCP server each bootstrap the kernel and call <code>invoke()</code> in their own process. Only the CLI, wrapped agents and HTTP clients reach it through <code>apps/api</code>.",
          "Counts on this page are read from the tree at build time (package manifests, the storage manifest, the capability manifest, route and function sources). If a number here disagrees with the code, the atlas is stale: run <code>pnpm docs:architecture</code>.",
        ],
      ),
  };
}

function workspace(m: Model): Section {
  const live = m.packages.filter(
    (p) => p.kind !== "tool" && !/deprecated/.test(p.name),
  );
  const nodes: DagNode[] = live.map((p) => ({
    id: p.name,
    label: short(p.name),
    kind: p.kind === "app" ? "app" : "pkg",
    sub: p.kind === "app" ? "app" : undefined,
  }));
  const edges: DagEdge[] = [];
  for (const p of live)
    for (const d of p.deps)
      if (live.some((x) => x.name === d)) edges.push({ from: p.name, to: d });
  const svg = renderDag(nodes, edges, {
    label:
      "Workspace dependency graph, apps on top, leaf packages at the bottom, edges implied by a longer path omitted.",
    transitiveReduction: true,
    nodeGapY: 64,
    nodeGapX: 14,
    minNodeW: 90,
  });
  const rows = m.packages.map((p) => [
    code(p.name),
    code(p.dir),
    p.kind,
    n(p.deps.length),
    n(p.externalDeps),
    esc(p.description || "—"),
  ]);
  const fanIn = new Map<string, number>();
  for (const p of m.packages)
    for (const d of p.deps) fanIn.set(d, (fanIn.get(d) ?? 0) + 1);
  const top = [...fanIn.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);
  return {
    id: "workspace",
    title: "Workspace",
    lede: `A pnpm + Turborepo monorepo: ${m.packages.filter((p) => p.kind === "app").length} apps, ${m.packages.filter((p) => p.kind === "package").length} packages and ${m.packages.filter((p) => p.kind === "tool").length} tool workspaces, one version for all of them.`,
    body:
      figure(
        "dep-graph",
        "Dependency graph",
        "Apps sit on top and depend downward; an edge is drawn only when no longer path implies it, so what remains is the load-bearing structure. Hover a node to trace its edges.",
        svg,
        [
          `Most depended-on: ${top.map(([k, v]) => `${code(short(k))} (${v})`).join(", ")}.`,
          "Deprecated and tool workspaces are listed in the table but left out of the drawing.",
        ],
      ) +
      `<h3>Workspaces</h3>` +
      table(
        [
          "Package",
          "Directory",
          "Kind",
          "Workspace deps",
          "External deps",
          "Description",
        ],
        rows,
        { id: "pkg-table", filter: true },
      ),
  };
}

function deploy(m: Model): Section {
  const pipeline = m.workflows.find((w) => w.file.endsWith("pipeline.yml"));
  let ci = "";
  if (pipeline) {
    const nodes: DagNode[] = pipeline.jobs.map((j) => ({
      id: j.id,
      label: j.id,
      sub:
        j.name && j.name !== j.id
          ? j.name.replace(/\$\{\{[^}]*\}\}/g, "…")
          : undefined,
      kind: /deploy/.test(j.id) ? "app" : "pkg",
      accent: /deploy/.test(j.id),
    }));
    const edges: DagEdge[] = [];
    for (const j of pipeline.jobs)
      for (const nd of j.needs)
        edges.push({ from: nd, to: j.id, label: "needs" });
    ci = figure(
      "ci-jobs",
      `CI job graph (${esc(pipeline.name)})`,
      "Pull requests and the merge queue run preflight, then checks, test, e2e, rls-integration and rds-compatibility, with atlas-validate alongside. On a push to main, staging waits on all six, migration-gate waits on staging and applies pending migrations, deploy-web waits on checks, test and staging, and deploy-node also waits on migration-gate.",
      renderDag(nodes, edges, {
        label: "CI job dependency graph",
        nodeGapY: 60,
        minNodeW: 120,
      }),
      [
        "<code>deploy-web</code> and <code>deploy-node</code> refuse to ship a commit that is no longer the tip of <code>main</code>, so a superseded queued run stays green without publishing.",
        "<code>manual-app-deploy</code> runs only on a manual dispatch. It is the break-glass path and does not wait on <code>migration-gate</code>.",
      ],
    );
  }
  const wfRows = m.workflows.map((w) => [
    code(w.file.replace(".github/workflows/", "")),
    esc(w.name),
    w.triggers.map((t) => `<span class="pill">${esc(t)}</span>`).join(" "),
    n(w.jobs.length),
  ]);
  const caddyRows = m.caddy.map((c) => [
    code(c.host),
    code(`127.0.0.1:${c.port}`),
  ]);
  const composeRows = m.composeServices.map((c) => [
    code(c.name),
    code(c.image),
  ]);
  return {
    id: "deploy",
    title: "Deployment",
    lede: "One AWS account managed by OpenTofu stacks under infra/stacks-new. Production runs on one application node behind an ALB, with Aurora for Postgres. Staging is a separate copy of that shape under staging.oxagen.sh. GitHub Actions deploys over OIDC.",
    body:
      flowsIn("deploy") +
      `<h3>Caddy host routing on the node</h3><p>Read from <code>infra/tools/caddy/Caddyfile.alb</code>.</p>` +
      table(["Host", "Upstream"], caddyRows) +
      ci +
      `<h3>Workflows</h3>` +
      table(["File", "Name", "Triggers", "Jobs"], wfRows, { id: "wf-table" }) +
      `<h3>Local development stack</h3><p>Services from <code>docker-compose.dev.yml</code>; Postgres is published on host port 5433 so it does not collide with another Postgres on 5432. stella-serve is published on 4300, the port app and api call.</p>` +
      table(["Service", "Image"], composeRows),
  };
}

function request(m: Model): Section {
  const tiers = Object.entries(m.apiTiers).map(([tier, chain]) => [
    `<b>${esc(tier)}</b>`,
    chain.map((c) => code(c)).join("<br>"),
  ]);
  const byTier = new Map<string, ApiRoute[]>();
  for (const r of m.apiRoutes)
    (byTier.get(r.tier) ?? byTier.set(r.tier, []).get(r.tier)!).push(r);
  const tierSummary = [...byTier.entries()].map(([t, rs]) => [
    `<b>${esc(t)}</b>`,
    n(rs.length),
    esc(
      [...new Set(rs.map((r) => r.path.split("/").slice(0, 4).join("/")))]
        .slice(0, 6)
        .join("  ·  "),
    ),
  ]);
  const rows = m.apiRoutes.map((r) => [
    `<span class="pill m-${r.method.toLowerCase()}">${r.method}</span>`,
    code(r.path),
    esc(r.tier),
    r.capability ? code(r.capability) : '<span class="muted">—</span>',
    code(r.file.replace("apps/api/src/routes/", "")),
  ]);
  return {
    id: "request",
    title: "Request path",
    lede: "Identity → tenant scope → capability → row-level security. Nothing reaches a tenant table without the four GUCs set, except through the audited withSystemDb bypass, and nothing reaches a handler without passing the kernel's gates.",
    body:
      flowsIn("request") +
      `<h3>Auth tiers in apps/api</h3><p>Middleware registered per sub-router in <code>apps/api/src/app.ts</code>, in the order Hono runs it.</p>` +
      table(["Tier", "Middleware chain"], tiers) +
      table(["Tier", "Routes", "Prefixes"], tierSummary) +
      `<h3>API routes</h3><p>Each route file declares a relative path; the prefix comes from where <code>app.ts</code> mounts it. The capability column is the contract the route hands to <code>invoke()</code>.</p>` +
      table(["Method", "Path", "Tier", "Capability", "Route file"], rows, {
        id: "route-table",
        filter: true,
      }),
  };
}

function kernel(m: Model): Section {
  const domains = [...new Set(m.capabilities.map((c) => c.domain))].sort();
  const surfaces = [
    ...new Set(m.capabilities.flatMap((c) => c.surfaces)),
  ].sort();
  const heat = domains.map((d) => {
    const caps = m.capabilities.filter((c) => c.domain === d);
    return [
      code(d),
      n(caps.length),
      ...surfaces.map((s) => {
        const k = caps.filter((c) => c.surfaces.includes(s)).length;
        return k
          ? `<span class="heat" style="--k:${(k / caps.length).toFixed(2)}">${k}</span>`
          : '<span class="muted">·</span>';
      }),
      n(caps.filter((c) => c.handlerFile).length),
    ];
  });
  const withHandler = m.capabilities.filter((c) => c.handlerFile).length;
  const rows = m.capabilities.map((c: Capability) => [
    code(c.name),
    code(c.domain),
    esc(c.mode),
    c.surfaces.map((s) => `<span class="pill">${esc(s)}</span>`).join(" "),
    Object.entries(c.layers)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(" · "),
    c.handlerFile
      ? code(c.handlerFile.replace("packages/handlers/src/", ""))
      : '<span class="muted">@oxagen/agent or inline</span>',
  ]);
  const surfacesNodes: GridNode[] = [
    {
      id: "api",
      label: "apps/api route",
      sub: "invoke(cap.name, …, { surface: 'api' })",
      col: 0,
      row: 0,
    },
    {
      id: "mcp",
      label: "apps/mcp tool",
      sub: "metadata.name = cap.name",
      col: 0,
      row: 1,
    },
    {
      id: "agent",
      label: "materialised tool",
      sub: "surface: 'agent'",
      col: 0,
      row: 2,
    },
    {
      id: "reg",
      label: "registerCapability",
      sub: "packages/oxagen/src/contracts/<stem>.ts",
      col: 1,
      row: 1,
      accent: true,
    },
    {
      id: "kernel",
      label: "invoke()",
      sub: "exact-name lookup",
      col: 2,
      row: 1,
    },
    {
      id: "handler",
      label: "registerHandler",
      sub: "packages/handlers/src/register.ts",
      col: 3,
      row: 1,
    },
    {
      id: "impl",
      label: "<stem>Handler",
      sub: "packages/handlers/src/<stem>.ts",
      col: 4,
      row: 1,
    },
  ];
  const surfacesEdges: GridEdge[] = [
    { from: "api", to: "reg", label: "imports contract" },
    { from: "mcp", to: "reg", label: "imports contract" },
    { from: "agent", to: "reg", label: "imports contract" },
    { from: "reg", to: "kernel", label: "registry Map" },
    { from: "kernel", to: "handler", label: "resolveHandler(name)" },
    { from: "handler", to: "impl", label: "lazy import()" },
  ];
  return {
    id: "kernel",
    title: "Capability kernel",
    lede: `${m.capabilities.length} typed contracts, one registry, one invoke(). A contract's dotless snake_case name is its identity (ADR-025); the dotted filename is only where it lives.`,
    body:
      figure(
        "contract-binding",
        "How a surface reaches a handler",
        "Every surface imports the same contract object and hands its name to invoke(); the handler is bound by name in one flat register file and imported lazily.",
        renderGrid(
          surfacesNodes,
          surfacesEdges,
          [],
          "Contract to handler binding",
          { cellW: 170 },
        ),
        [
          `${withHandler} of ${m.capabilities.length} contracts bind a handler in <code>@oxagen/handlers</code>; the rest register from <code>@oxagen/agent/register</code> or run inline.`,
          "The registry lives on <code>globalThis</code> under a symbol so a bundler's double evaluation cannot register twice; duplicates with a different signature warn instead of throwing.",
        ],
      ) +
      flowsIn("kernel") +
      `<h3>Domains × surfaces</h3><p>How many contracts in each domain are exposed on each surface. Read from <code>packages/oxagen/capabilities.manifest.json</code>.</p>` +
      table(["Domain", "Contracts", ...surfaces, "Handlers"], heat, {
        cls: "heatmap",
      }) +
      `<h3>Capability catalog</h3>` +
      table(["Name", "Domain", "Mode", "Surfaces", "Layers", "Handler"], rows, {
        id: "cap-table",
        filter: true,
      }),
  };
}

function knowledge(m: Model): Section {
  const labels = m.manifest.tables.filter((t) => t.store === "neo4j");
  const rows = labels.map((t) => [
    code(t.name),
    code(t.domain),
    t.columns.map((c) => c.name).join(", ") || "—",
    esc(t.meta?.constraints ?? t.meta?.indexes ?? "—"),
    t.tenantScoped ? "yes" : "—",
  ]);
  const vec = m.neo4jVectorIndexes.map((v) => [
    code(v.name),
    code(v.label),
    code(v.property),
  ]);
  return {
    id: "knowledge",
    title: "Knowledge graph",
    lede: "Connectors dual-write: Postgres holds the cursor and health, Neo4j holds entities, embeddings and relationships, ClickHouse observes. The ontology is tenant data in the schema registry.",
    body:
      flowsIn("knowledge") +
      `<h3 id="neo4j">Neo4j labels</h3><p>From <code>packages/ontology/src/schema.cypher</code> via the storage manifest. Relationship types are not static: each workspace declares them in a versioned schema in <code>schema_registry.relationship_types</code>. <code>RELATED_TO</code> is the fallback when a supplied type cannot be sanitised, and ingestion writes <code>ALIAS_OF</code> for deduplicated entities.</p>` +
      table(
        [
          "Label",
          "Domain",
          "Key properties",
          "Constraints / indexes",
          "Org-scoped",
        ],
        rows,
        { id: "neo-table", filter: true },
      ) +
      `<h3>Vector indexes</h3><p>All 1024-dimensional cosine, sized to voyage-3-large. <code>graph_node_embedding_index</code> is the universal one because every tenant node also carries the <code>GraphNode</code> anchor label.</p>` +
      table(["Index", "Label", "Property"], vec),
  };
}

function datastores(m: Model): Section {
  const stores = m.manifest.stores.map((s) => [
    code(s.kind),
    n(s.tableCount),
    esc(s.purpose),
    s.domains.map((d) => code(d)).join(" "),
  ]);
  const pgTables = m.manifest.tables.filter((t) => t.store === "postgres");
  const schemaOf = (id: string): string =>
    id.replace(/^postgres:/, "").split(".")[0]!;
  // schema-level graph
  const schemaNodes: DagNode[] = m.pgSchemas.map((s) => ({
    id: s.name,
    label: s.name,
    sub: `${pgTables.filter((t) => schemaOf(t.id) === s.name).length} tables`,
    kind: "pkg",
  }));
  const pairCount = new Map<string, number>();
  for (const e of m.postgresEdges) {
    const a = schemaOf(e.from);
    const b = schemaOf(e.to);
    if (a !== b)
      pairCount.set(`${a}→${b}`, (pairCount.get(`${a}→${b}`) ?? 0) + 1);
  }
  const schemaEdges: DagEdge[] = [...pairCount.entries()]
    .sort()
    .map(([k, v]) => {
      const [a, b] = k.split("→");
      return { from: a!, to: b!, label: String(v) };
    });
  const schemaSvg = renderDag(
    schemaNodes.filter(
      (s) =>
        schemaEdges.some((e) => e.from === s.id || e.to === s.id) ||
        pgTables.some((t) => schemaOf(t.id) === s.id),
    ),
    schemaEdges,
    {
      label:
        "Postgres schemas and the number of cross-schema references between them",
      nodeGapY: 80,
      minNodeW: 110,
    },
  );
  // ERDs per schema
  let erds = "";
  for (const s of m.pgSchemas) {
    const tables = pgTables.filter((t) => schemaOf(t.id) === s.name);
    if (!tables.length) continue;
    const erdTables: ErdTable[] = tables.map((t) => ({
      id: t.id,
      name: t.name,
      badge: m.rlsPolicies[t.id.replace(/^postgres:/, "")]
        ? `RLS ${m.rlsPolicies[t.id.replace(/^postgres:/, "")]}`
        : t.tenantScoped
          ? "tenant"
          : undefined,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        pk: c.primaryKey,
        nullable: c.nullable,
        fk:
          c.references ??
          m.postgresEdges.find(
            (e) => e.from === t.id && e.fromColumn === c.name,
          )?.to,
      })),
    }));
    const edges: ErdEdge[] = m.postgresEdges
      .filter((e) => e.from.startsWith(`postgres:${s.name}.`))
      .map((e) => ({
        from: e.from,
        fromColumn: e.fromColumn,
        to: e.to,
        inferred: e.source === "relations",
      }));
    const svg = renderErd(
      erdTables,
      edges,
      `Tables in the ${s.name} schema with their references`,
      { externalLabel: (id) => id.replace(/^postgres:/, "") },
    );
    const out = edges.filter((e) => schemaOf(e.to) !== s.name).length;
    erds += figure(
      `erd-${s.name}`,
      `${s.name} (${tables.length} tables)`,
      `Solid edges are declared foreign keys; dashed edges come from relations.ts, where every cross-schema tie lives by design. ${out ? `${out} reference${out > 1 ? "s" : ""} leave the schema and are drawn as stubs.` : "No reference leaves this schema."}`,
      svg,
    );
  }
  const chRows = m.clickhouse.map((t) => [
    code(t.name),
    code(t.engine),
    code(t.orderBy),
    n(t.columns.length),
    code(t.definedIn.replace("packages/telemetry/src/", "")),
  ]);
  const blob = m.manifest.tables
    .filter((t) => t.store === "blob")
    .map((t) => [
      code(t.name),
      esc(t.meta?.description ?? ""),
      esc(t.meta?.access ?? ""),
      esc(t.meta?.driver ?? ""),
    ]);
  const domainRows = m.manifest.domains.map((d) => [
    code(d.name),
    ...["postgres", "clickhouse", "neo4j", "blob"].map((s) => {
      const k = d.tables.filter((t) => t.startsWith(`${s}:`)).length;
      return k ? n(k) : '<span class="muted">·</span>';
    }),
  ]);
  return {
    id: "datastores",
    title: "Datastores",
    lede: "Four stores, one storage manifest (ADR-031) that the gate keeps byte-stable. Postgres is transactional truth under forced row-level security; ClickHouse is append-only telemetry; Neo4j is the graph; Blob holds bytes the Postgres row points at.",
    body:
      table(["Store", "Tables", "Purpose", "Domains"], stores) +
      `<h3>Domains across stores</h3><p>Rows are the platform's storage domains; a cell counts the tables (or labels) that domain owns in each store.</p>` +
      table(["Domain", "postgres", "clickhouse", "neo4j", "blob"], domainRows, {
        cls: "heatmap",
      }) +
      figure(
        "pg-schemas",
        "Postgres schemas",
        `${m.pgSchemas.length} pgSchema namespaces; an arrow's number is how many declared or logical references cross from one schema into another.`,
        schemaSvg,
        [
          "Tenancy columns come from mixins (<code>orgScopeMixin</code>, <code>auditMixin</code>, <code>softDeleteMixin</code>), so they are not literal in the table bodies but are present in every drawn card.",
          "Tables without <code>org_id</code> are isolated transitively through a policied parent or are shared catalogs; the RLS badge on each card names its policy class from <code>tenant-policy.manifest.ts</code>.",
        ],
      ) +
      `<h3>Entity relationships by schema</h3><p>◆ marks a primary key, → a referencing column, ? a nullable column. Composite primary keys are not visible to the manifest and show no ◆.</p>` +
      erds +
      `<h3 id="clickhouse">ClickHouse</h3><p>Replayed the way <code>packages/telemetry/src/migrate.ts</code> does: <code>schema.sql</code> first, then every numbered migration, honouring drops. The storage manifest only sees <code>schema.sql</code>, so this list is the fuller one.</p>` +
      table(["Table", "Engine", "ORDER BY", "Columns", "Defined in"], chRows, {
        id: "ch-table",
        filter: true,
      }) +
      `<h3>Blob</h3>` +
      table(["Asset kind", "Description", "Access", "Driver"], blob),
  };
}

function jobs(m: Model): Section {
  const nodes: DagNode[] = [];
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  const ev = (name: string): string => {
    const id = `ev:${name}`;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, label: name, kind: "event" });
    }
    return id;
  };
  for (const fn of m.inngest) {
    const id = `fn:${fn.id}`;
    nodes.push({
      id,
      label: fn.id,
      sub: fn.cron ? `cron ${fn.cron}` : undefined,
      kind: "fn",
      accent: !!fn.cron,
    });
    for (const t of fn.triggers)
      edges.push({ from: ev(t), to: id, label: "triggers" });
    for (const s of fn.sends)
      edges.push({ from: id, to: ev(s), label: "sends" });
  }
  const svg = renderDag(nodes, edges, {
    label:
      "Inngest events and functions: which event starts which function, and which events a function sends onward",
    direction: "right",
    nodeGapY: 90,
    minNodeW: 150,
  });
  const rows = m.inngest.map((fn) => [
    code(fn.id),
    fn.cron ? code(fn.cron) : fn.triggers.map((t) => code(t)).join("<br>"),
    fn.sends.map((s) => code(s)).join("<br>") || '<span class="muted">—</span>',
    fn.retries != null ? n(fn.retries) : "—",
    code(fn.file.replace("packages/inngest-functions/src/functions/", "")),
  ]);
  return {
    id: "jobs",
    title: "Background jobs",
    lede: `${m.inngest.length} Inngest functions served at /api/inngest on apps/api, read from the functions array that registers them. Trigger events are parsed with the scanner the gate uses to prove every event has a sender, and event constants are resolved from their declarations.`,
    body:
      figure(
        "inngest-graph",
        "Event → function → event",
        "Cron-driven functions are highlighted; everything else starts from an event some code path sends. Read left to right.",
        svg,
        [
          "Functions are declared through a local <code>createFunction</code> adapter that can return an on-failure companion, which is why some exports destructure two functions. The companions are served too and are not drawn.",
        ],
      ) +
      `<h3>Functions</h3>` +
      table(["Id", "Trigger", "Sends", "Retries", "File"], rows, {
        id: "fn-table",
        filter: true,
      }),
  };
}

function config(m: Model): Section {
  const services = ["api", "app", "mcp", "docs", "website", "admin"];
  const groups = [...new Set(m.env.map((e) => e.group))];
  let body = `<p>${m.env.length} variables from <code>packages/config/src/registry.ts</code>, the single source for <code>.env.example</code>, the env-manager catalog and the CI env checker. A dot marks a service that needs the variable; <b>R</b> marks environments where it is required.</p>`;
  for (const g of groups) {
    const rows = m.env
      .filter((e) => e.group === g)
      .map((e) => [
        `${code(e.key)}${e.secret ? ' <span class="pill secret">secret</span>' : ""}${e.clientExposed ? ' <span class="pill">client</span>' : ""}`,
        ...services.map((s) =>
          e.services.includes(s) ? "●" : '<span class="muted">·</span>',
        ),
        e.requiredIn
          .map(
            (r) =>
              `<abbr title="required in ${r}">${r[0]!.toUpperCase()}</abbr>`,
          )
          .join(" ") || '<span class="muted">—</span>',
        esc(e.valueOrigin),
        esc(e.description),
      ]);
    body +=
      `<h3>${esc(g)}</h3>` +
      table(
        ["Variable", ...services, "Required", "Origin", "Description"],
        rows,
        { cls: "env" },
      );
  }
  return {
    id: "config",
    title: "Configuration contract",
    lede: "Every deployable surface's environment, declared once and generated everywhere else.",
    body,
  };
}

function decisions(m: Model): Section {
  const epics = [...new Set(m.adrs.map((a) => a.epic))];
  let body = `<p>${m.adrs.length} records under <code>docs/adr</code>. ADRs are immutable once accepted; a change of mind is a new ADR that supersedes the old one, which is why superseded entries stay listed.</p>`;
  for (const e of epics) {
    const rows = m.adrs
      .filter((a) => a.epic === e)
      .map((a) => [
        `ADR-${String(a.number).padStart(3, "0")}`,
        esc(a.title),
        `<span class="pill s-${esc(a.status.toLowerCase().split(" ")[0]!)}">${esc(a.status || "—")}</span>`,
        esc(a.date || "—"),
      ]);
    body +=
      `<h3>${esc(e)}</h3>` + table(["#", "Title", "Status", "Date"], rows);
  }
  return {
    id: "decisions",
    title: "Decisions",
    lede: "The architecture decision records. ADR-001 to ADR-016 are grouped by the epic that produced them. Later records are listed under Unfiled until the index files them.",
    body,
  };
}

function surfaces(m: Model): Section {
  const cli = m.cli
    .filter((c) => !c.retired)
    .map((c) => [code(c.path.replace(/:/g, " ")), esc(c.description || "—")]);
  const retired = m.cli
    .filter((c) => c.retired)
    .map((c) => [code(c.path), esc(c.description)]);
  const mcpCaps = new Set(
    m.capabilities
      .filter((c) => c.surfaces.includes("mcp"))
      .map((c) => c.file.replace(/\.ts$/, "")),
  );
  const extra = m.mcpTools.filter((t) => !mcpCaps.has(t));
  return {
    id: "surfaces",
    title: "CLI and MCP surfaces",
    lede: "The CLI speaks HTTP to apps/api and mirrors response shapes by hand; the MCP server exposes one tool per contract whose surfaces include mcp, named exactly after the contract.",
    body:
      `<h3>MCP tools</h3><p>${m.mcpTools.length} tool files under <code>apps/mcp/src/tools</code>, ${mcpCaps.size} contracts declare the <code>mcp</code> surface.${extra.length ? ` Tool files with no matching contract stem: ${extra.map((t) => code(t)).join(", ")}.` : " Every tool file matches a contract stem."}</p>` +
      `<h3>CLI commands</h3><p>From <code>apps/cli/src/program.ts</code>, the side-effect-free Commander tree.</p>` +
      table(["Command", "Description"], cli, { id: "cli-table" }) +
      (retired.length
        ? `<h3>Retired commands</h3><p>Kept as stubs that explain where the capability went.</p>` +
          table(["Command", "Was"], retired)
        : ""),
  };
}

function about(m: Model, refCount: number): Section {
  return {
    id: "about",
    title: "About this atlas",
    lede: "Generated, not written. The docs build regenerates it from the tree; pnpm docs:architecture --check proves the cited sources still exist and the output is deterministic.",
    body:
      `<h3>Inputs</h3><ul class="notes">` +
      [
        "<code>apps/*/package.json</code>, <code>packages/*/package.json</code>, <code>tools/*/package.json</code>: the workspace graph.",
        `<code>packages/database/storage-manifest.json</code>: the ADR-031 platform storage ontology (content hash <code>${esc(m.manifest.contentHash.slice(0, 16))}…</code>), kept byte-stable by <code>pnpm schema:manifest:check</code>.`,
        "<code>packages/database/src/relations.ts</code>, <code>schema/_schemas.ts</code>, <code>tenant-policy.manifest.ts</code>: logical edges, schema namespaces, RLS classes.",
        "<code>packages/telemetry/src/schema.sql</code> + <code>migrations/*.sql</code>: ClickHouse, replayed in order.",
        "<code>packages/ontology/src/schema.cypher</code>: Neo4j vector indexes (labels arrive via the manifest).",
        "<code>packages/oxagen/capabilities.manifest.json</code> and <code>packages/handlers/src/register.ts</code>: contracts and handler bindings.",
        "<code>apps/api/src/app.ts</code> + <code>routes/**</code>: mounted routes, tiers, middleware chains.",
        "<code>apps/mcp/src/tools</code>, <code>apps/cli/src/program.ts</code>: the other two surfaces.",
        "<code>packages/inngest-functions/src/functions.ts</code> and <code>functions/*.ts</code>: the served array, each declaration scanned with the exported helpers of <code>check-inngest-senders.ts</code>.",
        "<code>packages/config/src/registry.ts</code>: <code>ENV_REGISTRY</code>, imported directly.",
        "<code>.github/workflows/*.yml</code>, <code>docs/adr/*.md</code>, <code>infra/tools/caddy/Caddyfile.alb</code>, <code>docker-compose.dev.yml</code>.",
      ]
        .map((s) => `<li>${s}</li>`)
        .join("") +
      `</ul><h3>Curated flows</h3><p>${flows.length} mechanism diagrams are hand-described in <code>tools/scripts/lib/archdocs/flows.ts</code> because they encode order, which no manifest records. Each cites the files and symbols it depicts (${refCount} references); the generator fails when any cited file or symbol is missing, so a flow cannot outlive the code it draws.</p>` +
      `<h3>Determinism</h3><p>No timestamps, no random ids, no network. Two builds of the same tree produce identical bytes. The output is not committed: <code>apps/docs</code> regenerates it as a <code>prebuild</code> step, so the published atlas always matches the tree it shipped with, and CI's <code>--check</code> guards the two things that can rot, cited sources and determinism.</p>`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface SitePage {
  /** `<title>`, meta, font link and stylesheet — goes in `<head>`. */
  head: string;
  /** Everything that goes in `<body>`, script included. */
  body: string;
}

/** A complete standalone document, for the static file the docs app serves. */
export function toDocument(page: SitePage): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n${page.head}\n</head>\n<body>\n${page.body}\n</body>\n</html>\n`;
}

export function renderSite(m: Model): SitePage {
  const refCount = flows.reduce((a, f) => a + f.refs.length, 0);
  const sections: Section[] = [
    overview(m),
    workspace(m),
    request(m),
    kernel(m),
    {
      id: "agent",
      title: "The governed turn",
      lede: "The repo's one agent loop is runGovernedTurn on stella-serve. Its main caller is the in-app assistant, a governed, metered Q&A turn over the fleet record and the knowledge graph. Run enrichment also calls it for a one-step, tool-less account of a recorded run. Every completion and tool call comes back to Oxagen to answer.",
      body: flowsIn("agent"),
    },
    {
      id: "evidence",
      title: "Evidence ledger and wrapped agents",
      lede: "Execution evidence arrives from agents that run outside Oxagen, and from the in-app assistant's own turns. The ledger stamps, seals and grades it. It never re-runs anything (ADR-043).",
      body: flowsIn("evidence"),
    },
    {
      id: "billing",
      title: "Metering and billing",
      lede: "The governed action is the billable unit. Tokens are reported at full price and billed at zero except when the platform key funds them.",
      body: flowsIn("billing"),
    },
    knowledge(m),
    datastores(m),
    jobs(m),
    surfaces(m),
    deploy(m),
    config(m),
    decisions(m),
    about(m, refCount),
  ];
  const nav = sections
    .map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`)
    .join("");
  const main = sections
    .map(
      (s) =>
        `<section id="${s.id}"><header class="sh"><h2>${esc(s.title)}</h2><p class="lede">${esc(s.lede)}</p></header>${s.body}</section>`,
    )
    .join("");
  const head = `<title>Oxagen Architecture Atlas</title>
<meta name="description" content="Generated architecture atlas of the Oxagen monorepo: datastores, schemas, request paths, kernel gates, evidence ledger, billing, deployment.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap">
<style>${CSS}</style>`;
  const body = `<div class="shell">
<nav class="rail" aria-label="Sections"><div class="brand"><span class="mark" aria-hidden="true"></span><span>Oxagen</span><small>architecture atlas</small></div>${nav}<div class="railfoot">Generated from the tree · <a href="#about">how</a></div></nav>
<main>
<header class="hero"><p class="eyebrow">Internal engineering docs</p><h1>Oxagen Architecture Atlas</h1><p class="herosub">What the monorepo is made of and how a request, a run, a governed action and a record move through it. Every figure is either generated from a manifest or cites the source it depicts.</p></header>
${main}
</main>
</div>
<script>${JS}</script>`;
  return { head, body };
}

const CSS = `
:root{--ground:#FAF8F3;--panel:#F1EDE4;--raised:#E9E3D6;--line:#D9D3C5;--rule:#C9C2B1;--ink:#1A1916;--ink-2:#3E3A33;--muted:#6E685C;--faint:#9A9385;--accent:#B8781E;--accent-ink:#8B5E1A;--fig-ground:#FAF8F3;--fig-panel:#FFFDF9;--fig-head:rgba(184,120,30,.10);--fig-group:rgba(184,120,30,.04);--fig-note:rgba(184,120,30,.08);--pill:#EDE6D8;--heat:184,120,30;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#10100F;--panel:#181715;--raised:#201F1C;--line:#292722;--rule:#34322D;--ink:#F2EEE5;--ink-2:#D9D4C8;--muted:#9B958A;--faint:#6B665C;--accent:#D6962C;--accent-ink:#F1C364;--fig-ground:#10100F;--fig-panel:#151412;--fig-head:rgba(214,150,44,.14);--fig-group:rgba(214,150,44,.05);--fig-note:rgba(214,150,44,.10);--pill:#242220;--heat:214,150,44;color-scheme:dark}}
:root[data-theme="dark"]{--ground:#10100F;--panel:#181715;--raised:#201F1C;--line:#292722;--rule:#34322D;--ink:#F2EEE5;--ink-2:#D9D4C8;--muted:#9B958A;--faint:#6B665C;--accent:#D6962C;--accent-ink:#F1C364;--fig-ground:#10100F;--fig-panel:#151412;--fig-head:rgba(214,150,44,.14);--fig-group:rgba(214,150,44,.05);--fig-note:rgba(214,150,44,.10);--pill:#242220;--heat:214,150,44;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 "Space Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
a{color:var(--accent-ink)}
code,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.86em}
code{background:var(--panel);padding:.08em .35em;border-radius:4px;color:var(--ink-2);overflow-wrap:anywhere}
.shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100%}
.rail{position:sticky;top:env(safe-area-inset-top,0px);height:100vh;overflow:auto;padding:22px 14px 18px 18px;border-right:1px solid var(--line);background:var(--ground);display:flex;flex-direction:column;gap:2px}
.rail a{display:block;padding:6px 8px;border-radius:6px;color:var(--ink-2);text-decoration:none;font-size:13.5px}
.rail a:hover,.rail a.on{background:var(--panel);color:var(--ink)}
.rail a.on{box-shadow:inset 3px 0 0 var(--accent)}
.brand{display:grid;grid-template-columns:auto 1fr;column-gap:8px;align-items:center;margin:0 8px 18px;font-weight:600;letter-spacing:.01em}
.brand small{grid-column:2;font-weight:400;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.mark{width:14px;height:14px;border-radius:3px;background:var(--accent);transform:rotate(45deg) scale(.8)}
.railfoot{margin-top:auto;padding:14px 8px 0;font-size:12px;color:var(--muted)}
main{padding:36px clamp(16px,4vw,56px) 96px;max-width:1180px}
.hero{max-width:68ch;margin-bottom:44px}
.eyebrow{margin:0 0 6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-ink);font-weight:600}
h1{font-size:clamp(28px,4vw,38px);line-height:1.1;margin:0 0 12px;letter-spacing:-.01em;text-wrap:balance}
.herosub{font-size:17px;color:var(--ink-2);margin:0}
section{padding:36px 0 8px;border-top:1px solid var(--line)}
.sh{max-width:70ch;margin-bottom:8px}
h2{font-size:24px;margin:0 0 8px;letter-spacing:-.01em;text-wrap:balance}
.lede{margin:0;color:var(--ink-2);font-size:15.5px}
h3{font-size:16px;margin:30px 0 8px;font-weight:600}
p{max-width:70ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:22px 0 6px}
.tile{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;text-decoration:none;color:inherit;background:var(--panel)}
.tile:hover{border-color:var(--rule)}
.tile .v{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tile .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.figure{margin:22px 0 30px}
.figure h3{margin:0 0 10px}
.figwrap{overflow-x:auto;padding:14px 10px;border:1px solid var(--line);border-radius:10px;background:var(--fig-ground)}
.fig{display:block;width:100%;max-width:100%;height:auto;color:var(--ink);font-family:"Space Grotesk",ui-sans-serif,system-ui,sans-serif}
.fig .sub,.fig .ctype,.fig .detail,.fig .group-label,.fig .num,.fig .exit,.fig .ext,.fig .badge{fill:var(--muted)}
.fig .elabel{fill:var(--ink-2)}
.fig .pk{font-weight:600}
.fig .node rect,.fig .table rect,.fig .lane rect{transition:stroke-width .12s}
.fig .node:hover rect{stroke-width:2}
.fig.dim .edge{opacity:.12}.fig.dim .edge.lit{opacity:1}.fig.dim .edge.lit path{stroke:var(--accent)}.fig.dim .node{opacity:.35}.fig.dim .node.lit{opacity:1}
figcaption{margin-top:10px;font-size:13.5px;color:var(--ink-2);max-width:78ch}
.notes{margin:8px 0 0;padding-left:18px;font-size:13.5px;color:var(--ink-2);max-width:78ch}
.notes li{margin:4px 0}
.refs{margin-top:8px;font-size:12.5px;color:var(--muted)}
.refs summary{cursor:pointer}
.refs ul{columns:2;padding-left:18px;margin:6px 0 0}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:8px;margin:8px 0 18px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{text-align:left;font-weight:600;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:9px 10px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td .num,.num{font-variant-numeric:tabular-nums}
.muted{color:var(--faint)}
.pill{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--pill);font-size:11.5px;color:var(--ink-2);white-space:nowrap}
.pill.secret{color:var(--accent-ink)}
.m-get{background:transparent;box-shadow:inset 0 0 0 1px var(--line)}
.s-accepted{color:var(--accent-ink)}.s-superseded{opacity:.7;text-decoration:line-through}.s-proposed{font-style:italic}
.heatmap td{text-align:center}.heatmap td:first-child{text-align:left}
.heat{display:inline-block;min-width:26px;padding:2px 6px;border-radius:4px;background:rgba(var(--heat),calc(.12 + .5*var(--k)));font-variant-numeric:tabular-nums}
.env td:nth-child(n+2):nth-child(-n+7){text-align:center;font-size:12px}
.env abbr{text-decoration:none;font-weight:600;color:var(--accent-ink)}
.filter{display:flex;align-items:center;gap:10px;margin:8px 0 0;font-size:13px}
.filter label{color:var(--muted)}
.filter input{flex:1;max-width:360px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);font:inherit}
.filter input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.filter .count{color:var(--muted);font-variant-numeric:tabular-nums}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:860px){.shell{grid-template-columns:minmax(0,1fr)}.rail{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);flex-direction:row;flex-wrap:wrap;gap:4px;padding:14px 16px}.brand{width:100%;margin-bottom:6px}.railfoot{display:none}main{padding:24px 16px 64px}.refs ul{columns:1}}
`;

const JS = `
(function(){
  var links=[].slice.call(document.querySelectorAll('.rail a[href^="#"]'));
  var secs=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1))}).filter(Boolean);
  function mark(){var y=window.scrollY+120,cur=secs[0];for(var i=0;i<secs.length;i++){if(secs[i].offsetTop<=y)cur=secs[i]}links.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+cur.id)})}
  window.addEventListener('scroll',mark,{passive:true});mark();
  document.querySelectorAll('input[data-filter]').forEach(function(inp){
    var t=document.getElementById(inp.getAttribute('data-filter'));if(!t)return;
    var rows=[].slice.call(t.tBodies[0].rows),cnt=document.querySelector('[data-count="'+t.id+'"]');
    var texts=rows.map(function(r){return r.textContent.toLowerCase()});
    inp.addEventListener('input',function(){var q=inp.value.trim().toLowerCase().split(/\\s+/).filter(Boolean),k=0;rows.forEach(function(r,i){var ok=q.every(function(w){return texts[i].indexOf(w)>-1});r.hidden=!ok;if(ok)k++});if(cnt)cnt.textContent=k});
  });
  document.querySelectorAll('svg.dag, svg.erd').forEach(function(svg){
    var nodes=svg.querySelectorAll('.node, .table');
    nodes.forEach(function(nd){
      nd.addEventListener('mouseenter',function(){var id=nd.getAttribute('data-id');svg.classList.add('dim');var lit={};lit[id]=1;svg.querySelectorAll('.edge').forEach(function(e){if(e.getAttribute('data-from')===id||e.getAttribute('data-to')===id){e.classList.add('lit');lit[e.getAttribute('data-from')]=1;lit[e.getAttribute('data-to')]=1}});nodes.forEach(function(x){if(lit[x.getAttribute('data-id')])x.classList.add('lit')})});
      nd.addEventListener('mouseleave',function(){svg.classList.remove('dim');svg.querySelectorAll('.lit').forEach(function(x){x.classList.remove('lit')})});
    });
  });
})();
`;
