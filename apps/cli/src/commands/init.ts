/**
 * `oxagen init` — scaffold project + global settings, build the code graph,
 * and print graph statistics + inferred domains.
 *
 * Mirrors the Claude Code `~/.claude` (global) + `.claude/` (project) two-tier
 * model. Precedence (lowest → highest), matching the existing settings/resolve.ts:
 *   1. Global user:  ~/.config/oxagen/settings.json
 *   2. Project:      <cwd>/.oxagen/settings.json
 *   3. Local:        <cwd>/.oxagen/settings.local.json  (not written by init)
 *
 * Credentials (token, org, workspace, gatewayKey) intentionally stay in
 * ~/.config/oxagen/config.json — never in settings files — consistent with
 * Claude Code keeping .credentials.json separate from settings.json.
 *
 * `init` is idempotent: re-running updates the code graph incrementally but
 * leaves any existing settings files untouched (no clobbering).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeStarterSettings } from "../settings/write.js";
import {
  buildAndPersistCodeGraph,
  buildCodeGraph,
  listSourceFiles,
} from "../daemon/code-graph/builder.js";
import {
  createCodeGraphStore,
  defaultCodeGraphDbPath,
} from "../daemon/code-graph/store.js";
import { ensureGatewayKey } from "../agent/env.js";
import { inferDomains } from "@oxagen/code-graph";
import type { DomainAI, DomainMap } from "@oxagen/code-graph";
import { modelForTier } from "../agent/model-router.js";
import { generateObject } from "ai";
import type { CodeGraph } from "../daemon/code-graph/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Workspace root. Defaults to process.cwd(). */
  cwd?: string;
  /** Override user settings path (test seam). */
  userSettingsPath?: string;
  /** Override DuckDB path (test seam). Pass ":memory:" for in-process tests. */
  _duckdbPath?: string;
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
}

export interface InitGraphStats {
  files: number;
  totalSymbols: number;
  totalEdges: number;
  symbolsByKind: Record<string, number>;
  edgesByType: Record<string, number>;
  languages: string[];
  indexed: number;
  skipped: number;
}

export interface InitResult {
  projectSettingsPath: string;
  projectSettingsCreated: boolean;
  userSettingsPath: string;
  userSettingsCreated: boolean;
  graph: InitGraphStats;
  domains: Array<{ name: string; files: number }> | null;
  domainsSkipped: boolean;
}

// ---------------------------------------------------------------------------
// Settings scaffolding
// ---------------------------------------------------------------------------

/**
 * Ensure both the global user and project settings files exist.
 * Returns paths and whether each was newly created.
 * Never clobbers existing files — idempotent.
 */
export function ensureSettingsFiles(opts: {
  cwd: string;
  userSettingsPath?: string;
}): {
  projectPath: string;
  projectCreated: boolean;
  userPath: string;
  userCreated: boolean;
} {
  const user = writeStarterSettings({
    scope: "user",
    cwd: opts.cwd,
    userSettingsPath: opts.userSettingsPath,
  });
  const project = writeStarterSettings({
    scope: "project",
    cwd: opts.cwd,
    userSettingsPath: opts.userSettingsPath,
  });
  return {
    userPath: user.path,
    userCreated: user.created,
    projectPath: project.path,
    projectCreated: project.created,
  };
}

// ---------------------------------------------------------------------------
// Graph stats
// ---------------------------------------------------------------------------

/** Compute per-kind symbol counts, per-type edge counts, and languages from a graph. */
function computeGraphStats(
  graph: CodeGraph,
  indexed: number,
  skipped: number,
): InitGraphStats {
  let files = 0;
  const symbolsByKind: Record<string, number> = {};
  const languageSet = new Set<string>();

  for (const node of graph.nodes.values()) {
    if (node.kind === "file") {
      files++;
      if (node.language && node.language !== "unknown") {
        languageSet.add(node.language);
      }
    } else {
      symbolsByKind[node.kind] = (symbolsByKind[node.kind] ?? 0) + 1;
    }
  }

  const edgesByType: Record<string, number> = {};
  for (const edge of graph.edges) {
    edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1;
  }

  const totalSymbols = Object.values(symbolsByKind).reduce((a, b) => a + b, 0);

  return {
    files,
    totalSymbols,
    totalEdges: graph.edges.length,
    symbolsByKind,
    edgesByType,
    languages: [...languageSet].sort(),
    indexed,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

/** Format an InitResult into a human-readable summary string. */
export function formatInitSummary(result: InitResult): string {
  const lines: string[] = [];

  // Settings tier
  lines.push("Settings:");
  lines.push(
    `  ${result.userSettingsCreated ? "Created" : "Found  "}  ${result.userSettingsPath}  (global)`,
  );
  lines.push(
    `  ${result.projectSettingsCreated ? "Created" : "Found  "}  ${result.projectSettingsPath}  (project)`,
  );
  lines.push(
    "  Precedence: global < project < local (.oxagen/settings.local.json)",
  );
  lines.push("");

  // Code graph
  lines.push(
    `Code graph  (${result.graph.files} files · ${result.graph.totalSymbols} symbols · ${result.graph.totalEdges} edges):`,
  );
  lines.push(
    `  Indexed:   ${result.graph.indexed}  skipped (unchanged): ${result.graph.skipped}`,
  );

  if (result.graph.languages.length > 0) {
    lines.push(`  Languages: ${result.graph.languages.join(", ")}`);
  }

  // Symbols by kind
  const kindEntries = Object.entries(result.graph.symbolsByKind).sort(
    (a, b) => b[1] - a[1],
  );
  if (kindEntries.length > 0) {
    const kindStr = kindEntries.map(([k, v]) => `${k}:${v}`).join("  ");
    lines.push(`  Symbols:   ${kindStr}`);
  }

  // Edges by type
  const edgeEntries = Object.entries(result.graph.edgesByType).sort(
    (a, b) => b[1] - a[1],
  );
  if (edgeEntries.length > 0) {
    const edgeStr = edgeEntries.map(([k, v]) => `${k}:${v}`).join("  ");
    lines.push(`  Edges:     ${edgeStr}`);
  }

  lines.push("");

  // Domains
  if (result.domainsSkipped) {
    lines.push(
      "Domains:   skipped — no AI gateway key (run `oxagen login` or set AI_GATEWAY_API_KEY)",
    );
  } else if (!result.domains || result.domains.length === 0) {
    lines.push("Domains:   none inferred");
  } else {
    lines.push("Domains:");
    for (const d of result.domains) {
      const bar = "█".repeat(Math.max(1, Math.round((d.files / result.graph.files) * 20)));
      lines.push(
        `  ${d.name.padEnd(22)} ${String(d.files).padStart(4)} file${d.files === 1 ? " " : "s"}  ${bar}`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run the init workflow and return a structured result.
 * Both the CLI handler and the REPL /init command call this.
 */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const cwd = opts.cwd ?? process.cwd();

  // 1. Scaffold settings files (idempotent — never clobbers)
  const settings = ensureSettingsFiles({
    cwd,
    userSettingsPath: opts.userSettingsPath,
  });

  // 2. Build code graph incrementally via DuckDB store
  const duckdbPath = opts._duckdbPath ?? defaultCodeGraphDbPath();
  if (duckdbPath !== ":memory:") {
    mkdirSync(dirname(duckdbPath), { recursive: true });
  }

  let graph: CodeGraph;
  let indexed = 0;
  let skipped = 0;

  const store = createCodeGraphStore({ duckdbPath });
  try {
    await store.whenReady();
    const buildResult = await buildAndPersistCodeGraph(cwd, store);
    indexed = buildResult.indexed;
    skipped = buildResult.skipped;
    graph = await store.loadGraph(cwd);
  } catch {
    // Store locked (daemon holds write lock) — fall back to in-memory build.
    // This still gives accurate stats; they just won't be persisted.
    graph = await buildCodeGraph(cwd);
    indexed = graph.nodes.size;
    skipped = 0;
  } finally {
    try {
      await store.close();
    } catch {
      /* ignore close errors */
    }
  }

  const graphStats = computeGraphStats(graph, indexed, skipped);

  // 3. Domain inference — best-effort; gracefully skipped when no gateway key
  let domains: Array<{ name: string; files: number }> | null = null;
  let domainsSkipped = false;

  const gatewayKey = ensureGatewayKey(cwd);
  if (!gatewayKey) {
    domainsSkipped = true;
  } else {
    try {
      const allFiles = await listSourceFiles(cwd);
      const domainModel = modelForTier("fast"); // Haiku-class — cheap classification
      const domainAI: DomainAI = {
        generateObject: (args) => generateObject({ model: domainModel, ...args }),
      };
      const domainMap: DomainMap = await inferDomains({ files: allFiles }, domainAI);

      // Aggregate per-domain file counts
      const counts = new Map<string, number>();
      for (const domain of domainMap.values()) {
        if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }

      domains = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, files]) => ({ name, files }));
    } catch {
      // AI errors never block init
      domainsSkipped = true;
    }
  }

  return {
    projectSettingsPath: settings.projectPath,
    projectSettingsCreated: settings.projectCreated,
    userSettingsPath: settings.userPath,
    userSettingsCreated: settings.userCreated,
    graph: graphStats,
    domains,
    domainsSkipped,
  };
}

// ---------------------------------------------------------------------------
// CLI handler (writes to stdout)
// ---------------------------------------------------------------------------

export async function handleInit(opts: InitOptions): Promise<void> {
  process.stderr.write("Initializing…\n");

  const result = await runInit(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatInitSummary(result) + "\n");
}
