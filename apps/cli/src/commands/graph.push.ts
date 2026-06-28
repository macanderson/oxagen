/**
 * `oxagen graph push` — compute a git-native code delta and push it to the
 * workspace knowledge graph (ADR-018 slice 2, up-sync).
 *
 * Delta computation:
 *   - If a code-push cursor (last synced git SHA) exists and `--full` is NOT
 *     set: diff from the stored SHA to HEAD (`git diff --name-status`).
 *   - On first run, or when `--full` is passed: walk all tracked source files
 *     (`git ls-files`).
 *
 * Re-running the same HEAD SHA is idempotent: the same `idempotencyKey` is
 * sent, and the handler MERGEs are no-ops.
 *
 * Storage boundary (ADR-018):
 *   - Code subgraph → Neo4j (is_system=true) via `graph.sync.push`.
 *   - Local cursor (last synced SHA) → DuckDB (GraphStore.code_push_cursor).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { buildCodeGraph } from "../daemon/code-graph/builder.js";
import { apiPost } from "../lib/api.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";
import { createGraphStore } from "@oxagen/engram";
import { graphStorePath } from "./graph.pull.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphPushOptions {
  full?: boolean;
  repo?: string;
  json?: boolean;
  /** @internal test seam: override the DuckDB path. */
  _duckdbPath?: string;
  /** @internal test seam: override the git root (workspace root). */
  _gitRoot?: string;
}

interface PushEnvelope {
  source: "code";
  idempotencyKey: string;
  nodes: PushNode[];
  edges: PushEdge[];
  tombstones?: Array<{ key: string }>;
}

interface PushNode {
  key: string;
  labels: string[];
  displayName: string;
  properties: Record<string, unknown>;
  isSystem: true;
}

interface PushEdge {
  sourceKey: string;
  targetKey: string;
  type: string;
  properties?: Record<string, unknown>;
  inferred?: boolean;
}

interface PushResult {
  nodesUpserted: number;
  edgesUpserted: number;
  tombstoned: number;
}

// Edge types from the code-graph builder (lowercase) → uppercase for Neo4j
const EDGE_TYPE_MAP: Record<string, string> = {
  calls: "CALLS",
  imports: "IMPORTS",
  exports: "EXPORTS",
  extends: "EXTENDS",
  implements: "IMPLEMENTS",
  contains: "CONTAINS",
  references: "REFERENCES",
};

const SUPPORTED_EXTENSIONS_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt)$/;

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command with `execFileSync` and return stdout as a trimmed string.
 * Throws when the command fails (non-zero exit).
 */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Return the current HEAD SHA (full 40-char). */
function headSha(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd);
}

/** Return the git repo root absolute path. */
function gitRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * Stable repo identifier — prefer the remote origin URL (git-host-agnostic),
 * fall back to a short hash of the absolute root path when no remote exists.
 */
function repoId(root: string): string {
  try {
    const url = git(["remote", "get-url", "origin"], root);
    if (url) return url;
  } catch {
    // no remote — use path hash
  }
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

/**
 * Return the list of changed source files between `fromSha` and `toSha`.
 * Output: `{ added: string[], deleted: string[] }` (relative paths).
 */
function changedFiles(
  fromSha: string,
  toSha: string,
  root: string,
): { added: string[]; deleted: string[] } {
  const raw = git(["diff", "--name-status", `${fromSha}..${toSha}`], root);
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split("\t");
    const file = rest.join("\t").trim();
    if (!file || !SUPPORTED_EXTENSIONS_RE.test(file)) continue;
    if (status === "D") {
      deleted.push(file);
    } else {
      // A (added), M (modified), R (renamed), C (copied) → re-extract
      added.push(file);
    }
  }
  return { added, deleted };
}

/**
 * Return all tracked source files in the repo (for a full push).
 */
function allTrackedFiles(root: string): string[] {
  const raw = git(["ls-files"], root);
  return raw
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f && SUPPORTED_EXTENSIONS_RE.test(f));
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

/**
 * Build nodes and edges for a set of files by running them through the
 * code-graph builder and mapping to the `graph.sync.push` envelope shape.
 */
async function buildEnvelopeForFiles(
  files: string[],
  root: string,
  repo: string,
): Promise<{ nodes: PushNode[]; edges: PushEdge[] }> {
  if (files.length === 0) return { nodes: [], edges: [] };

  // Build the code graph for the entire root (builder walks all files). We
  // then filter to only the requested files to keep the delta tight.
  const graph = await buildCodeGraph(root);

  const nodeMap = new Map<string, PushNode>();
  const edgeList: PushEdge[] = [];

  // Index code graph nodes by their relative path for fast lookup.
  const nodesByPath = new Map<string, string[]>(); // path → node keys
  for (const [, n] of graph.nodes) {
    if (n.kind === "file") {
      // File node key is simpler
      const fileKey = `code:${repo}:${n.path}`;
      const pushNode: PushNode = {
        key: fileKey,
        labels: ["SourceFile"],
        displayName: n.name,
        properties: { path: n.path, language: n.language },
        isSystem: true,
      };
      nodeMap.set(fileKey, pushNode);
      const existing = nodesByPath.get(n.path) ?? [];
      existing.push(fileKey);
      nodesByPath.set(n.path, existing);
    } else {
      // Symbol node
      const symbolKey = `code:${repo}:${n.path}#${n.name}:${n.kind}`;
      const props: Record<string, unknown> = {
        path: n.path,
        language: n.language,
        kind: n.kind,
        lineStart: n.range.start,
        lineEnd: n.range.end,
      };
      if (n.signature) props["signature"] = n.signature;
      if (n.docstring) props["docstring"] = n.docstring;
      const pushNode: PushNode = {
        key: symbolKey,
        // Must be "SourceSymbol" (not "Symbol") to match the GitHub-ingestion
        // tree-sitter writer and the reader createNeo4jCodeGraphProvider, which
        // both query :SourceSymbol. A bare :Symbol label made every CLI-pushed
        // symbol invisible to the in-app agent (cross-surface drift).
        labels: ["SourceSymbol"],
        displayName: n.name,
        properties: props,
        isSystem: true,
      };
      nodeMap.set(symbolKey, pushNode);
      // Also track symbol under its file path for edge lookup
      const existing = nodesByPath.get(n.path) ?? [];
      existing.push(symbolKey);
      nodesByPath.set(n.path, existing);
      // Keep internal id → key mapping for edge resolution
      nodeMap.set(n.id, pushNode); // id → push node (may collide — no-op dup)
    }
  }

  // Also build a map from internal builder ID to push key
  const idToKey = new Map<string, string>();
  for (const [, n] of graph.nodes) {
    if (n.kind === "file") {
      idToKey.set(n.id, `code:${repo}:${n.path}`);
    } else {
      idToKey.set(n.id, `code:${repo}:${n.path}#${n.name}:${n.kind}`);
    }
  }

  // Filter to only files in the requested set
  const fileSet = new Set(files);
  const filteredNodeKeys = new Set<string>();
  for (const [, n] of graph.nodes) {
    if (fileSet.has(n.path)) {
      const key = idToKey.get(n.id);
      if (key) filteredNodeKeys.add(key);
    }
  }

  // Build edges involving the filtered nodes
  for (const e of graph.edges) {
    const srcKey = idToKey.get(e.source);
    const tgtKey = idToKey.get(e.target);
    if (!srcKey || !tgtKey) continue;
    // Only include edges where at least one endpoint is in the changed files
    if (!filteredNodeKeys.has(srcKey) && !filteredNodeKeys.has(tgtKey)) continue;
    const relType = EDGE_TYPE_MAP[e.type] ?? e.type.toUpperCase();
    edgeList.push({ sourceKey: srcKey, targetKey: tgtKey, type: relType });
  }

  // Collect nodes that are referenced by the filtered edges (to avoid dangling refs)
  const nodesInEdges = new Set<string>();
  for (const e of edgeList) {
    nodesInEdges.add(e.sourceKey);
    nodesInEdges.add(e.targetKey);
  }

  // Final node list: union of filteredNodeKeys + edge endpoints
  const finalNodeKeys = new Set([...filteredNodeKeys, ...nodesInEdges]);
  const nodes: PushNode[] = [];
  for (const key of finalNodeKeys) {
    const n = nodeMap.get(key);
    if (n) nodes.push(n);
  }

  return { nodes, edges: edgeList };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphPush(opts: GraphPushOptions): Promise<void> {
  const org = getOrgId();
  const workspace = getWorkspaceId();

  if (!org || !workspace) {
    process.stderr.write(
      "Missing org or workspace. Run `oxagen config` or set " +
        "OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.\n",
    );
    process.exitCode = 1;
    return;
  }

  // Resolve the git root — default to cwd, override in tests.
  let root: string;
  try {
    root = opts._gitRoot ?? gitRoot(process.cwd());
  } catch {
    process.stderr.write(
      "Not inside a git repository. `oxagen graph push` requires a git repo.\n",
    );
    process.exitCode = 1;
    return;
  }

  const repo = opts.repo ?? repoId(root);

  // Resolve DuckDB path.
  const duckdbPath = opts._duckdbPath ?? graphStorePath(workspace);
  if (duckdbPath !== ":memory:") {
    mkdirSync(dirname(duckdbPath), { recursive: true });
  }

  const store = createGraphStore({ duckdbPath });
  try {
    const currentSha = headSha(root);
    const lastSha = opts.full ? null : await store.getCodeCursor(org, workspace, repo);

    let addedFiles: string[];
    let deletedFiles: string[];

    if (!lastSha) {
      // First run or --full: push all tracked source files.
      addedFiles = allTrackedFiles(root);
      deletedFiles = [];
    } else if (lastSha === currentSha) {
      // Already up to date — idempotent no-op.
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ upToDate: true, sha: currentSha, repo }) + "\n",
        );
      } else {
        process.stdout.write(
          `Already up to date (HEAD: ${currentSha.slice(0, 8)}).\n`,
        );
      }
      return;
    } else {
      const changed = changedFiles(lastSha, currentSha, root);
      addedFiles = changed.added;
      deletedFiles = changed.deleted;
    }

    // Build the push envelope.
    const { nodes, edges } = await buildEnvelopeForFiles(addedFiles, root, repo);

    // Tombstones for deleted files: file node + all symbol nodes that share the path.
    // We use a coarse key (`code:{repo}:{path}`) and a symbol-prefix pattern. For
    // simplicity, we tombstone only the file node; symbol nodes are orphaned and
    // will be swept by a future compaction. (Symbols that are still referenced via
    // their edges will stay; fully orphaned ones can be tombstoned in a follow-up.)
    const tombstones = deletedFiles.map((f) => ({ key: `code:${repo}:${f}` }));

    const idempotencyKey = lastSha
      ? `code:${repo}:${lastSha}:${currentSha}`
      : `code:${repo}:full:${currentSha}`;

    const envelope: PushEnvelope = {
      source: "code",
      idempotencyKey,
      nodes,
      edges,
      ...(tombstones.length > 0 ? { tombstones } : {}),
    };

    if (nodes.length === 0 && edges.length === 0 && tombstones.length === 0) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ pushed: false, reason: "no changes", sha: currentSha, repo }) + "\n",
        );
      } else {
        process.stdout.write(`No source file changes since ${lastSha?.slice(0, 8) ?? "start"}.\n`);
      }
      // Still update the cursor so next run doesn't re-scan
      await store.setCodeCursor(org, workspace, repo, currentSha);
      return;
    }

    process.stderr.write(
      `Pushing ${nodes.length} node(s), ${edges.length} edge(s), ` +
        `${tombstones.length} tombstone(s)...\n`,
    );

    const result = await apiPost<PushResult>("graph/sync/push", envelope);

    // Persist the cursor on success.
    await store.setCodeCursor(org, workspace, repo, currentSha);

    const summary = {
      nodesUpserted: result.nodesUpserted,
      edgesUpserted: result.edgesUpserted,
      tombstoned: result.tombstoned,
      sha: currentSha,
      repo,
      fromSha: lastSha ?? "(full)",
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Pushed to workspace graph:\n` +
          `  Nodes upserted:  ${result.nodesUpserted}\n` +
          `  Edges upserted:  ${result.edgesUpserted}\n` +
          `  Tombstoned:      ${result.tombstoned}\n` +
          `  From SHA:        ${(lastSha ?? "(full)").toString().slice(0, 8)}\n` +
          `  To SHA (HEAD):   ${currentSha.slice(0, 8)}\n` +
          `  Repo:            ${repo}\n`,
      );
    }
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// Status helper — exposes code-push cursor for `oxagen graph status`
// ---------------------------------------------------------------------------

/**
 * Return the last code-push SHA for the given workspace + repo, or null.
 * Used by `oxagen graph status` to show the push cursor alongside the pull cursor.
 */
export async function getCodePushCursor(
  org: string,
  workspace: string,
  repo: string,
  duckdbPath: string,
): Promise<string | null> {
  const store = createGraphStore({ duckdbPath });
  try {
    return await store.getCodeCursor(org, workspace, repo);
  } finally {
    await store.close();
  }
}

// Re-export path helper (tests + status command use it)
export { join, homedir };
