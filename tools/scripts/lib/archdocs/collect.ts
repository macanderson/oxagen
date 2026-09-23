/**
 * Collectors for the architecture atlas.
 *
 * Each collector reads one committed source of truth (a manifest the gate
 * already keeps fresh, or the source files themselves) and returns plain,
 * sorted data. Nothing here touches a network, a database, or the clock, so
 * the same tree always produces the same model — that is what lets
 * `--check` diff the output in CI.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { sendersIn, triggersIn } from "../../check-inngest-senders";

export interface WorkspacePackage {
  name: string;
  dir: string;
  kind: "app" | "package" | "tool";
  description: string;
  deps: string[];
  externalDeps: number;
}

export interface ManifestColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  references?: string;
}
export interface ManifestTable {
  id: string;
  name: string;
  store: "postgres" | "clickhouse" | "neo4j" | "blob";
  domain: string;
  tenantScoped: boolean;
  columns: ManifestColumn[];
  meta?: Record<string, string>;
}
export interface StorageManifest {
  version: number;
  contentHash: string;
  stores: {
    kind: string;
    purpose: string;
    tableCount: number;
    domains: string[];
  }[];
  domains: { name: string; stores: string[]; tables: string[] }[];
  tables: ManifestTable[];
}

export interface LogicalEdge {
  from: string; // postgres:schema.table
  fromColumn: string;
  to: string;
  source: "references" | "relations";
}

export interface ClickHouseTable {
  name: string;
  engine: string;
  orderBy: string;
  columns: { name: string; type: string }[];
  definedIn: string;
}

export interface ApiRoute {
  method: string;
  path: string;
  tier: string;
  file: string;
  capability?: string;
}

export interface Capability {
  name: string;
  file: string;
  domain: string;
  mode: string;
  surfaces: string[];
  layers: Record<string, boolean>;
  handlerFile?: string;
}

export interface InngestFunction {
  id: string;
  file: string;
  triggers: string[];
  cron?: string;
  sends: string[];
  retries?: number;
}

export interface EnvVar {
  key: string;
  group: string;
  description: string;
  secret: boolean;
  clientExposed: boolean;
  services: string[];
  requiredIn: string[];
  valueOrigin: string;
}

export interface Workflow {
  file: string;
  name: string;
  triggers: string[];
  jobs: { id: string; name?: string; needs: string[] }[];
}

export interface Adr {
  number: number;
  slug: string;
  title: string;
  status: string;
  date: string;
  epic: string;
  file: string;
}

export interface CliCommand {
  path: string;
  description: string;
  retired?: boolean;
}

export interface CaddyRoute {
  host: string;
  port: number;
}

export interface Model {
  root: string;
  packages: WorkspacePackage[];
  manifest: StorageManifest;
  postgresEdges: LogicalEdge[];
  rlsPolicies: Record<string, string>;
  pgSchemas: { name: string; exportName: string; file: string }[];
  clickhouse: ClickHouseTable[];
  neo4jVectorIndexes: { name: string; label: string; property: string }[];
  apiRoutes: ApiRoute[];
  apiTiers: Record<string, string[]>;
  capabilities: Capability[];
  mcpTools: string[];
  cli: CliCommand[];
  inngest: InngestFunction[];
  env: EnvVar[];
  workflows: Workflow[];
  adrs: Adr[];
  caddy: CaddyRoute[];
  composeServices: { name: string; image: string }[];
  infraFiles: string[];
}

const read = (p: string): string => readFileSync(p, "utf8");
const by =
  <T>(f: (t: T) => string) =>
  (a: T, b: T) =>
    f(a).localeCompare(f(b));

// ── Workspace ────────────────────────────────────────────────────────────────

export function collectWorkspace(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const [dir, kind] of [
    ["apps", "app"],
    ["packages", "package"],
    ["tools", "tool"],
  ] as const) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort()) {
      const pj = join(base, d, "package.json");
      if (!existsSync(pj)) continue;
      const j = JSON.parse(read(pj)) as {
        name: string;
        description?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const all = {
        ...j.dependencies,
        ...j.devDependencies,
        ...j.peerDependencies,
      };
      const deps = Object.entries(all)
        .filter(([, v]) => String(v).startsWith("workspace:"))
        .map(([k]) => k)
        .sort();
      out.push({
        name: j.name,
        dir: `${dir}/${d}`,
        kind,
        description: j.description ?? "",
        deps,
        externalDeps: Object.keys(j.dependencies ?? {}).filter(
          (k) => !k.startsWith("@oxagen/"),
        ).length,
      });
    }
  }
  return out.sort(by((p) => p.name));
}

// ── Storage manifest (ADR-031) ───────────────────────────────────────────────

export function collectManifest(root: string): StorageManifest {
  return JSON.parse(
    read(join(root, "packages/database/storage-manifest.json")),
  ) as StorageManifest;
}

export function collectPgSchemas(
  root: string,
): { name: string; exportName: string; file: string }[] {
  const src = read(join(root, "packages/database/src/schema/_schemas.ts"));
  const out: { name: string; exportName: string; file: string }[] = [];
  for (const m of src.matchAll(/export const (\w+) = pgSchema\("(\w+)"\)/g))
    out.push({
      exportName: m[1]!,
      name: m[2]!,
      file: "packages/database/src/schema/_schemas.ts",
    });
  return out.sort(by((s) => s.name));
}

/** Drizzle export name → manifest table id, from the schema sources. */
export function collectTableExports(root: string): Map<string, string> {
  const schemas = new Map(
    collectPgSchemas(root).map((s) => [s.exportName, s.name]),
  );
  const dir = join(root, "packages/database/src/schema");
  const map = new Map<string, string>();
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".ts") || f.startsWith("_") || f === "index.ts") continue;
    const src = read(join(dir, f));
    for (const m of src.matchAll(
      /export const (\w+) = (\w+)\.table\(\s*"([a-z0-9_]+)"/g,
    )) {
      const schema = schemas.get(m[2]!);
      if (schema) map.set(m[1]!, `postgres:${schema}.${m[3]}`);
    }
  }
  return map;
}

/**
 * Edges between Postgres tables: declared `.references()` (from the manifest)
 * plus the logical `relations()` in relations.ts — the file that carries every
 * cross-schema tie, since the schema builders deliberately declare none.
 */
export function collectPostgresEdges(
  root: string,
  manifest: StorageManifest,
): LogicalEdge[] {
  const edges = new Map<string, LogicalEdge>();
  for (const t of manifest.tables) {
    if (t.store !== "postgres") continue;
    for (const c of t.columns)
      if (c.references)
        edges.set(`${t.id}.${c.name}`, {
          from: t.id,
          fromColumn: c.name,
          to: c.references,
          source: "references",
        });
  }
  const exportsMap = collectTableExports(root);
  const rel = read(join(root, "packages/database/src/relations.ts"));
  const colName = (table: string, camel: string): string => {
    // find the column's SQL name by matching camelCase → snake_case; the manifest is the check
    const snake = camel.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    const t = manifest.tables.find((x) => x.id === table);
    return t?.columns.some((c) => c.name === snake) ? snake : camel;
  };
  for (const m of rel.matchAll(
    /one\(\s*(\w+)\s*,\s*\{[^}]*?fields:\s*\[\s*(\w+)\.(\w+)\s*\][^}]*?references:\s*\[\s*(\w+)\.(\w+)\s*\]/gs,
  )) {
    const from = exportsMap.get(m[2]!);
    const to = exportsMap.get(m[4]!);
    if (!from || !to) continue;
    const key = `${from}.${colName(from, m[3]!)}`;
    if (!edges.has(key))
      edges.set(key, {
        from,
        fromColumn: colName(from, m[3]!),
        to,
        source: "relations",
      });
  }
  return [...edges.values()].sort(
    by((e) => `${e.from}.${e.fromColumn}->${e.to}`),
  );
}

export function collectRlsPolicies(root: string): Record<string, string> {
  const src = read(
    join(root, "packages/database/src/tenant-policy.manifest.ts"),
  );
  const out: Record<string, string> = {};
  for (const m of src.matchAll(
    /\{\s*table:\s*"([a-z0-9_.]+)",\s*policyClass:\s*"(\w+)"\s*\}/g,
  ))
    out[m[1]!] = m[2]!;
  return out;
}

// ── ClickHouse ───────────────────────────────────────────────────────────────

/** Replays schema.sql then every numbered migration, the way migrate.ts does. */
export function collectClickHouse(root: string): ClickHouseTable[] {
  const dir = join(root, "packages/telemetry/src");
  const files = [
    join(dir, "schema.sql"),
    ...readdirSync(join(dir, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(dir, "migrations", f)),
  ];
  const tables = new Map<string, ClickHouseTable>();
  for (const f of files) {
    const src = read(f).replace(/--[^\n]*/g, "");
    for (const m of src.matchAll(/DROP TABLE IF EXISTS\s+([a-z0-9_]+)/gi))
      tables.delete(m[1]!);
    for (const m of src.matchAll(
      /CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*ENGINE\s*=\s*([A-Za-z]+(?:\([^)]*\))?)([\s\S]*?);/gi,
    )) {
      const name = m[1]!;
      const body = m[2]!;
      const engine = m[3]!;
      const tail = m[4]!;
      const orderBy =
        /ORDER BY\s*(\([^)]*\)|[a-z0-9_]+)/i.exec(tail)?.[1] ?? "";
      const columns: { name: string; type: string }[] = [];
      let depth = 0;
      let cur = "";
      const parts: string[] = [];
      for (const ch of body) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          parts.push(cur);
          cur = "";
        } else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      for (const p of parts) {
        const line = p.trim().replace(/\s+/g, " ");
        const cm =
          /^`?([a-z0-9_]+)`?\s+([A-Za-z0-9_(), ]+?)(?:\s+(?:DEFAULT|CODEC|COMMENT|MATERIALIZED|ALIAS)\b.*)?$/i.exec(
            line,
          );
        if (cm && !/^(INDEX|PROJECTION|CONSTRAINT|PRIMARY)$/i.test(cm[1]!))
          columns.push({ name: cm[1]!, type: cm[2]!.trim() });
      }
      tables.set(name, {
        name,
        engine,
        orderBy: orderBy.replace(/\s+/g, " "),
        columns,
        definedIn: relative(root, f),
      });
    }
  }
  return [...tables.values()].sort(by((t) => t.name));
}

// ── Neo4j ────────────────────────────────────────────────────────────────────

export function collectNeo4jVectorIndexes(
  root: string,
): { name: string; label: string; property: string }[] {
  const src = read(join(root, "packages/ontology/src/schema.cypher"));
  const out: { name: string; label: string; property: string }[] = [];
  for (const m of src.matchAll(
    /CREATE VECTOR INDEX\s+(\w+)\s+IF NOT EXISTS\s+FOR\s+\(\w+:(\w+)\)\s+ON\s+\(\w+\.(\w+)\)/gi,
  ))
    out.push({ name: m[1]!, label: m[2]!, property: m[3]! });
  const dropped = new Set(
    [...src.matchAll(/DROP INDEX\s+(\w+)/gi)].map((m) => m[1]!),
  );
  return out.filter((i) => !dropped.has(i.name)).sort(by((i) => i.name));
}

// ── API routes (Hono) ────────────────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  app: "public",
  userScoped: "user",
  orgOnlyScoped: "org",
  orgScoped: "org+workspace",
  tachoScoped: "tacho host",
  stellaTelemetryScoped: "stella telemetry",
};

export function collectApiRoutes(
  root: string,
  capabilities: Capability[],
): { routes: ApiRoute[]; tiers: Record<string, string[]> } {
  const appSrc = read(join(root, "apps/api/src/app.ts"));
  const imports = new Map<string, string>();
  for (const m of appSrc.matchAll(
    /import \{ (\w+) \} from "\.\/routes\/([^"]+)"/g,
  ))
    imports.set(m[1]!, `apps/api/src/routes/${m[2]}.ts`);
  const mounts: { router: string; prefix: string; target: string }[] = [];
  for (const m of appSrc.matchAll(/^(\w+)\.route\("([^"]*)",\s*(\w+)\)/gm))
    mounts.push({ router: m[1]!, prefix: m[2]!, target: m[3]! });
  const routerPrefix = new Map<string, string>([["app", ""]]);
  for (const m of mounts)
    if (!imports.has(m.target))
      routerPrefix.set(m.target, (routerPrefix.get(m.router) ?? "") + m.prefix);
  const tiers: Record<string, string[]> = {};
  for (const m of appSrc.matchAll(/^(\w+)\.use\("([^"]*)",\s*([^)]+)\)/gm)) {
    const label = TIER_LABELS[m[1]!] ?? m[1]!;
    (tiers[label] ??= []).push(`${m[2]} → ${m[3]!.replace(/\s+/g, " ")}`);
  }
  const capByFile = new Map(
    capabilities.map((c) => [c.file.replace(/\.ts$/, ""), c.name]),
  );
  const routes: ApiRoute[] = [];
  for (const m of mounts) {
    const file = imports.get(m.target);
    if (!file) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const src = read(abs);
    const base = (routerPrefix.get(m.router) ?? "") + m.prefix;
    const tier = TIER_LABELS[m.router] ?? m.router;
    const contractImports = new Map<string, string>();
    for (const im of src.matchAll(
      /import \{([^}]+)\} from "@oxagen\/oxagen\/contracts\/([^"]+)"/g,
    ))
      for (const name of im[1]!
        .split(",")
        .map((s) => s.trim().split(" as ")[0]!.trim()))
        contractImports.set(name, im[2]!);
    const decls = [
      ...src.matchAll(/(\w+)\.(get|post|put|patch|delete|all)\(\s*"([^"]*)"/g),
    ];
    if (decls.length === 0) continue;
    for (const d of decls) {
      // capability: nearest following invoke(<var>.name
      const after = src.slice(d.index!);
      const inv = /invoke\(\s*(\w+)\.name/.exec(after);
      const stem = inv ? contractImports.get(inv[1]!) : undefined;
      const capability = stem ? capByFile.get(stem) : undefined;
      const sub = d[3] === "/" ? "" : d[3]!;
      routes.push({
        method: d[2]!.toUpperCase(),
        path: (base + sub).replace(/\/+/g, "/") || "/",
        tier,
        file,
        capability,
      });
    }
  }
  const uniq = new Map<string, ApiRoute>();
  for (const r of routes) uniq.set(`${r.method} ${r.path}`, r);
  return {
    routes: [...uniq.values()].sort(
      by((r) => `${r.tier} ${r.path} ${r.method}`),
    ),
    tiers,
  };
}

// ── Capabilities + handlers ──────────────────────────────────────────────────

export function collectCapabilities(root: string): Capability[] {
  const m = JSON.parse(
    read(join(root, "packages/oxagen/capabilities.manifest.json")),
  ) as { capabilities: Capability[] };
  const reg = read(join(root, "packages/handlers/src/register.ts"));
  const handlers = new Map<string, string>();
  // Two registration shapes: `async () => (await import("./x")).handler` and
  // `() => import("./x").then((m) => m.handler)`.
  for (const h of reg.matchAll(
    /registerHandler\(\s*"(\w+)",\s*(?:async \(\) =>\s*\(await import\("\.\/([^"]+)"\)\)|\(\) =>\s*import\("\.\/([^"]+)"\)\.then)/g,
  ))
    handlers.set(h[1]!, `packages/handlers/src/${h[2] ?? h[3]}.ts`);
  return m.capabilities
    .map((c) => ({
      ...c,
      surfaces: [...c.surfaces].sort(),
      handlerFile: handlers.get(c.name),
    }))
    .sort(by((c) => `${c.domain} ${c.name}`));
}

export function collectMcpTools(root: string): string[] {
  const dir = join(root, "apps/mcp/src/tools");
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir)
      // `_`-prefixed files are shared helpers, not tools.
      .filter(
        (f) =>
          f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_"),
      )
      .map((f) => f.replace(/\.ts$/, ""))
      .sort()
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function collectCli(root: string): CliCommand[] {
  const src = read(join(root, "apps/cli/src/program.ts"));
  const out: CliCommand[] = [];
  for (const m of src.matchAll(/retiredCommand\("([\w-]+)",\s*"([^"]*)"\)/g))
    out.push({ path: m[1]!, description: m[2]!, retired: true });
  const re =
    /(?:const (\w+) = )?(\w+)\s*\n?\s*\.command\("([\w:-]+)(?:\s[^"]*)?"(?:,\s*\{[^}]*\})?\)\s*(?:\n?\s*\/\/[^\n]*)*\s*(?:\n?\s*\.alias\("[^"]*"\))?\s*(?:\n?\s*\.description\(\s*"([^"]*)"|\.description\(\s*\n\s*"([^"]*)")?/g;
  // parent variable → command path
  const scan = (body: string, parents: Map<string, string>): void => {
    for (const m of body.matchAll(re)) {
      const [, assigned, parentVar, name, d1, d2] = m;
      const parentPath = parents.get(parentVar!);
      if (parentPath === undefined) continue;
      const path = parentPath ? `${parentPath}:${name}` : name!;
      if (assigned) parents.set(assigned, path);
      out.push({ path, description: (d1 ?? d2 ?? "").trim() });
    }
  };
  const parents = new Map<string, string>([["program", ""]]);
  scan(src, parents);
  // Helpers such as `addHostWrapCommands(parent: Command)` add the same
  // subcommands under every command they are called with. Scan each helper's
  // body once per call site, with its parameter bound to the caller's path.
  for (const h of src.matchAll(
    /(?:^|\n)function (\w+)\((\w+): Command\)[^{]*\{([\s\S]*?)\n\}/g,
  )) {
    const [, fn, param, body] = h;
    for (const call of src.matchAll(new RegExp(`\\b${fn}\\((\\w+)\\)`, "g"))) {
      const at = parents.get(call[1]!);
      if (at === undefined) continue;
      scan(body!, new Map([[param!, at]]));
    }
  }
  return out.sort(by((c) => c.path));
}

// ── Inngest ──────────────────────────────────────────────────────────────────

export function collectInngest(root: string): InngestFunction[] {
  const pkg = join(root, "packages/inngest-functions/src");
  const dir = join(pkg, "functions");
  // What apps/api serves is the `functions` array, not every file on disk: a
  // file whose export is not in that array is never registered with Inngest.
  const servedSrc = read(join(pkg, "functions.ts"));
  const arrayAt = servedSrc.indexOf("export const functions");
  const served = new Set(
    [...servedSrc.slice(arrayAt).matchAll(/^\s*(\w+),$/gm)].map((m) => m[1]!),
  );
  // Event names declared as constants: `export const X_EVENT = "a/b";`, in the
  // function's own file or the shared events module.
  const constantsIn = (src: string): Map<string, string> =>
    new Map(
      [...src.matchAll(/\bconst (\w+)\s*=\s*"([^"]+)"/g)].map(
        (m) => [m[1]!, m[2]!] as const,
      ),
    );
  const shared = existsSync(join(pkg, "events.ts"))
    ? constantsIn(read(join(pkg, "events.ts")))
    : new Map<string, string>();
  const out: InngestFunction[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".ts") || /\.(test|spec)\.ts$/.test(f)) continue;
    const src = read(join(dir, f));
    const rel = relative(root, join(dir, f));
    const local = constantsIn(src);
    // One file can declare several functions: split at each
    // `export const [name(, onFailure)?] = createFunction(`.
    const starts = [
      ...src.matchAll(
        /export const \[(\w+)(?:,\s*(\w+))?\]\s*=\s*createFunction\(/g,
      ),
    ];
    starts.forEach((start, i) => {
      const name = start[1]!;
      if (!served.has(name)) return;
      // A single-function file is read whole, helpers included; a
      // multi-function file is read one declaration at a time.
      const seg =
        starts.length === 1
          ? src
          : src.slice(start.index, starts[i + 1]?.index ?? src.length);
      const events = [
        ...triggersIn(seg, rel).map((t) => t.event),
        ...[...seg.matchAll(/\bevent:\s*([A-Z][A-Z0-9_]+)\b/g)]
          .map((m) => local.get(m[1]!) ?? shared.get(m[1]!))
          .filter((e): e is string => e !== undefined),
      ];
      const id = /\bid:\s*"([^"]+)"/.exec(seg)?.[1] ?? name;
      const cron = /\bcron:\s*"([^"]+)"/.exec(seg)?.[1];
      const retries = /\bretries:\s*(\d+)/.exec(seg)?.[1];
      const sends = [
        ...new Set([
          ...sendersIn(seg),
          ...[...seg.matchAll(/\bname:\s*([A-Z][A-Z0-9_]+)\b/g)]
            .map((m) => local.get(m[1]!) ?? shared.get(m[1]!))
            .filter((e): e is string => e !== undefined),
        ]),
      ].sort();
      out.push({
        id,
        file: rel,
        triggers: [...new Set(events)].sort(),
        cron,
        sends,
        retries: retries ? Number(retries) : undefined,
      });
    });
  }
  return out.sort(by((fn) => fn.id));
}

// ── Environment contract ─────────────────────────────────────────────────────

export async function collectEnv(): Promise<EnvVar[]> {
  const cfg = (await import("@oxagen/config")) as {
    ENV_REGISTRY: Record<string, Omit<EnvVar, "key">>;
  };
  return Object.entries(cfg.ENV_REGISTRY)
    .map(([key, v]) => ({
      key,
      group: v.group,
      description: v.description,
      secret: !!v.secret,
      clientExposed: !!v.clientExposed,
      services: [...(v.services ?? [])].sort(),
      requiredIn: [...(v.requiredIn ?? [])].sort(),
      valueOrigin: v.valueOrigin,
    }))
    .sort(by((e) => `${e.group} ${e.key}`));
}

// ── GitHub workflows ─────────────────────────────────────────────────────────

export function collectWorkflows(root: string): Workflow[] {
  const dir = join(root, ".github/workflows");
  const out: Workflow[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const src = read(join(dir, f));
    const name = /^name:\s*(.+)$/m.exec(src)?.[1]?.trim() ?? f;
    const onIdx = src.search(/^on:/m);
    const triggers: string[] = [];
    if (onIdx >= 0) {
      // `[ \t]*`, not `\s*`: a block-style `on:` must not reach the next line.
      const onLine = /^on:[ \t]*([^#\n]*)/m.exec(src)![1]!.trim();
      if (onLine.startsWith("["))
        triggers.push(
          ...onLine
            .replace(/[[\]]/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      else if (onLine && onLine !== "|")
        triggers.push(onLine.split(":")[0]!.trim());
      else {
        const rest = src.slice(onIdx).split("\n").slice(1);
        for (const line of rest) {
          if (/^\S/.test(line)) break;
          const m = /^ {2}([a-z_]+):/.exec(line);
          if (m) triggers.push(m[1]!);
        }
      }
    }
    const jobs: Workflow["jobs"] = [];
    const jobsIdx = src.search(/^jobs:/m);
    if (jobsIdx >= 0) {
      const lines = src.slice(jobsIdx).split("\n").slice(1);
      let cur: Workflow["jobs"][number] | null = null;
      for (const line of lines) {
        if (/^\S/.test(line)) break;
        const j = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
        if (j) {
          cur = { id: j[1]!, needs: [] };
          jobs.push(cur);
          continue;
        }
        if (!cur) continue;
        const n = /^ {4}name:\s*(.+)$/.exec(line);
        if (n) cur.name = n[1]!.trim().replace(/^["']|["']$/g, "");
        const needs = /^ {4}needs:\s*\[?([^\]]*)\]?\s*$/.exec(line);
        if (needs && needs[1]!.trim())
          cur.needs = needs[1]!
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      }
    }
    out.push({
      file: `.github/workflows/${f}`,
      name,
      triggers: [...new Set(triggers)],
      jobs,
    });
  }
  return out;
}

// ── ADRs ─────────────────────────────────────────────────────────────────────

export function collectAdrs(root: string): Adr[] {
  const dir = join(root, "docs/adr");
  const readme = read(join(dir, "README.md"));
  const epicOf = new Map<number, string>();
  let epic = "";
  for (const line of readme.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) epic = h[1]!.replace(/ epic$/, "");
    const a = /\[ADR-(\d+)\]/.exec(line);
    if (a && epic) epicOf.set(Number(a[1]), epic);
  }
  const out: Adr[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^ADR-(\d+)-(.+)\.md$/.exec(f);
    if (!m) continue;
    const src = read(join(dir, f));
    const head = src.split("\n").slice(0, 14).join("\n");
    const title =
      /^# ADR-\d+:?\s*(.+)$/m.exec(src)?.[1]?.trim() ??
      m[2]!.replace(/-/g, " ");
    // Headers vary: "**Status:** Accepted (2026-06-27)", "- Status: accepted",
    // "Date: … · Status: Accepted · Scope: …". Take the word run after the label.
    // A "## Status" heading puts the word on a later line instead.
    const rawStatus =
      /\bStatus:?\*{0,2}:?[ \t]*([A-Za-z][^\n·|]*)/.exec(head)?.[1] ??
      /^## Status\s*\n\s*\**([A-Za-z][^\n·|]*)/m.exec(head)?.[1] ??
      "";
    const clause = rawStatus.split(/[(.—;,*]| - /)[0]!.trim();
    // Keep the status word and a short qualifier ("in part", "by ADR-043"),
    // not a sentence of context after it.
    const status = (
      /^(?:accepted|proposed|superseded|deprecated|rejected|draft|withdrawn)(?:\s+(?:in part|by ADR-\d+))?/i.exec(
        clause,
      )?.[0] ?? clause
    ).replace(/^[a-z]/, (c) => c.toUpperCase());
    const date = /(\d{4}-\d{2}-\d{2})/.exec(head)?.[1] ?? "";
    const epicRaw = epicOf.get(Number(m[1]));
    const epic =
      !epicRaw || /not yet filed/i.test(epicRaw) ? "Unfiled" : epicRaw;
    out.push({
      number: Number(m[1]),
      slug: m[2]!,
      title,
      status,
      date,
      epic,
      file: `docs/adr/${f}`,
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

// ── Infra ────────────────────────────────────────────────────────────────────

export function collectCaddy(root: string): CaddyRoute[] {
  const p = join(root, "infra/tools/caddy/Caddyfile.alb");
  if (!existsSync(p)) return [];
  const src = read(p);
  const out: CaddyRoute[] = [];
  const hosts = new Map<string, string>();
  for (const m of src.matchAll(/@(\w+)\s+host\s+(\S+)/g))
    hosts.set(m[1]!, m[2]!);
  for (const m of src.matchAll(
    /handle\s+@(\w+)\s*\{[^}]*?reverse_proxy\s+127\.0\.0\.1:(\d+)/gs,
  )) {
    const host = hosts.get(m[1]!);
    if (host) out.push({ host, port: Number(m[2]) });
  }
  return out.sort(by((r) => r.host));
}

export function collectCompose(
  root: string,
): { name: string; image: string }[] {
  const p = join(root, "docker-compose.dev.yml");
  if (!existsSync(p)) return [];
  const src = read(p);
  const out: { name: string; image: string }[] = [];
  const svcIdx = src.search(/^services:/m);
  const block = src.slice(svcIdx).split(/^volumes:/m)[0]!;
  let cur = "";
  for (const line of block.split("\n")) {
    const s = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (s) cur = s[1]!;
    const img = /^\s{4}image:\s*(.+)$/.exec(line);
    if (img && cur) out.push({ name: cur, image: img[1]!.trim() });
  }
  return out;
}

export function listFiles(
  root: string,
  dir: string,
  pred: (f: string) => boolean = () => true,
): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d).sort()) {
      if (f === "node_modules" || f.startsWith(".")) continue;
      const full = join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else if (pred(full)) out.push(relative(root, full));
    }
  };
  const base = join(root, dir);
  if (existsSync(base)) walk(base);
  return out;
}

// ── Whole model ──────────────────────────────────────────────────────────────

export async function collectModel(root: string): Promise<Model> {
  const manifest = collectManifest(root);
  const capabilities = collectCapabilities(root);
  const { routes, tiers } = collectApiRoutes(root, capabilities);
  return {
    root,
    packages: collectWorkspace(root),
    manifest,
    postgresEdges: collectPostgresEdges(root, manifest),
    rlsPolicies: collectRlsPolicies(root),
    pgSchemas: collectPgSchemas(root),
    clickhouse: collectClickHouse(root),
    neo4jVectorIndexes: collectNeo4jVectorIndexes(root),
    apiRoutes: routes,
    apiTiers: tiers,
    capabilities,
    mcpTools: collectMcpTools(root),
    cli: collectCli(root),
    inngest: collectInngest(root),
    env: await collectEnv(),
    workflows: collectWorkflows(root),
    adrs: collectAdrs(root),
    caddy: collectCaddy(root),
    composeServices: collectCompose(root),
    infraFiles: listFiles(root, "infra/stacks-new", (f) =>
      f.endsWith(".tf"),
    ).concat(
      listFiles(root, "infra/modules", (f) => basename(f) === "main.tf"),
    ),
  };
}
