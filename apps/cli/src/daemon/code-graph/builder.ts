/**
 * Code graph builder — constructs the initial code graph from a workspace
 * by walking files and extracting symbols via @oxagen/code-graph (tree-sitter).
 *
 * Previously used a simplified regex-based extraction. Now unified with the
 * platform ingestion path: both consumers use parseSourceFile() from
 * @oxagen/code-graph, backed by the same tree-sitter WASM grammars.
 *
 * Language coverage: TypeScript, JavaScript, JSX/TSX, Python.
 * Go/Rust/Java: file nodes are created but symbols are skipped (parseSourceFile
 * returns language "unknown" — the outer loop still walks the files).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseSourceFile, type SymbolKind } from "@oxagen/code-graph";
import type { CodeGraph, CodeNode, CodeEdge, CodeNodeKind } from "./types";
import { hashContent } from "./store";
import type { FileGraph, CodeGraphStore } from "./store";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "coverage",
  ".turbo", ".vercel", "__pycache__",
]);

// ---------------------------------------------------------------------------
// ParsedSymbol → CodeNodeKind mapping
// ---------------------------------------------------------------------------

/** Map a tree-sitter SymbolKind to the CLI's CodeNodeKind. */
function symbolKindToNodeKind(kind: SymbolKind): CodeNodeKind | null {
  switch (kind) {
    case "function":      return "function";
    case "class":         return "class";
    case "method":        return "method";
    case "interface":     return "interface";
    case "type":          return "type";
    case "arrow_function": return "arrow_function";
    case "heading":       return null; // markdown headings: skip in code graph
    default:              return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an in-memory code graph from a workspace root directory.
 */
export async function buildCodeGraph(workspaceRoot: string): Promise<CodeGraph> {
  const graph: CodeGraph = { nodes: new Map(), edges: [] };
  for (const rel of await listSourceFiles(workspaceRoot)) {
    const fg = await extractFileGraph(path.join(workspaceRoot, rel), workspaceRoot);
    if (!fg) continue;
    for (const node of fg.nodes) graph.nodes.set(node.id, node);
    graph.edges.push(...fg.edges);
  }
  return graph;
}

/** Walk the workspace and return every supported source file as a root-relative path. */
export async function listSourceFiles(workspaceRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkDirectory(workspaceRoot, workspaceRoot, out);
  return out;
}

async function walkDirectory(dir: string, root: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDirectory(fullPath, root, out);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.relative(root, fullPath));
    }
  }
}

/**
 * Extract one file's subgraph from already-read content: its file node, the
 * symbols it declares (with `contains` edges), and its resolved relative-import
 * edges, plus a content hash for incremental persistence. Async because
 * parseSourceFile() initialises the tree-sitter WASM on the first call.
 */
export async function fileGraphFromContent(
  relativePath: string,
  content: string,
  root: string,
): Promise<FileGraph> {
  const language = extensionToLanguage(path.extname(relativePath));
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];

  const fileNode: CodeNode = {
    id: computeNodeId(relativePath, path.basename(relativePath), "file"),
    kind: "file",
    name: path.basename(relativePath),
    path: relativePath,
    range: { start: 0, end: 0 },
    language,
  };
  nodes.push(fileNode);

  // Use the tree-sitter parser from @oxagen/code-graph (same as platform ingestion).
  const parseResult = await parseSourceFile(relativePath, content);
  for (const sym of parseResult.symbols) {
    const nodeKind = symbolKindToNodeKind(sym.kind);
    if (!nodeKind) continue; // skip headings and other non-code symbols

    const symbolNode: CodeNode = {
      id: computeNodeId(relativePath, sym.name, nodeKind),
      kind: nodeKind,
      name: sym.name,
      path: relativePath,
      range: { start: sym.startLine + 1, end: sym.endLine + 1 },
      language,
      ...(sym.signature ? { signature: sym.signature } : {}),
      ...(sym.docComment ? { docstring: sym.docComment } : {}),
    };
    nodes.push(symbolNode);
    edges.push({ source: fileNode.id, target: symbolNode.id, type: "contains" });
  }

  edges.push(...extractImports(content, relativePath, root));

  return { contentHash: hashContent(content), nodes, edges };
}

/** Read + extract one file's subgraph. Returns null if the file can't be read. */
export async function extractFileGraph(filePath: string, root: string): Promise<FileGraph | null> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  return fileGraphFromContent(path.relative(root, filePath), content, root);
}

/**
 * Incrementally build the code graph for `root` into a CodeGraphStore: only
 * files whose content hash changed are re-parsed and persisted; files that
 * vanished from disk are dropped. This is the persistent counterpart to
 * buildCodeGraph and the basis for warm cold-starts (ADR-016 P0).
 */
export async function buildAndPersistCodeGraph(
  root: string,
  store: CodeGraphStore,
): Promise<{ indexed: number; skipped: number; removed: number }> {
  const onDisk = await listSourceFiles(root);
  const onDiskSet = new Set(onDisk);
  let indexed = 0;
  let skipped = 0;

  for (const rel of onDisk) {
    let content: string;
    try {
      content = await fs.promises.readFile(path.join(root, rel), "utf-8");
    } catch {
      continue; // disappeared mid-walk
    }
    if ((await store.fileHash(root, rel)) === hashContent(content)) {
      skipped++;
      continue;
    }
    await store.replaceFile(root, rel, await fileGraphFromContent(rel, content, root));
    indexed++;
  }

  // Drop files indexed previously that no longer exist on disk.
  let removed = 0;
  for (const rel of await store.indexedFiles(root)) {
    if (!onDiskSet.has(rel)) {
      await store.removeFile(root, rel);
      removed++;
    }
  }

  return { indexed, skipped, removed };
}

// ---------------------------------------------------------------------------
// Import edge extraction (pure regex — tree-sitter isn't needed for this)
// ---------------------------------------------------------------------------

/** Extensions tried (in order) when resolving an import specifier to a file. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Resolve a *relative* import specifier to the workspace-relative path of the
 * file it actually points to, so the resulting edge targets the same node id
 * the file node was created with (`computeNodeId(relPath, basename, "file")`).
 */
function resolveRelativeImport(
  spec: string,
  importerRelPath: string,
  root: string,
): string | null {
  const baseAbs = path.resolve(root, path.dirname(importerRelPath), spec);
  const ext = path.extname(baseAbs);
  const stem = ext ? baseAbs.slice(0, -ext.length) : baseAbs;

  const candidates: string[] = [];
  if (ext && SUPPORTED_EXTENSIONS.has(ext)) candidates.push(baseAbs);
  for (const e of RESOLVE_EXTENSIONS) candidates.push(stem + e);
  for (const e of RESOLVE_EXTENSIONS) candidates.push(path.join(baseAbs, "index" + e));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return path.relative(root, candidate);
    } catch {
      // not this candidate
    }
  }
  return null;
}

/**
 * Extract import edges from file content, resolving each relative specifier to
 * the real target file node so the dependency graph is queryable.
 */
function extractImports(content: string, filePath: string, root: string): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const fileId = computeNodeId(filePath, path.basename(filePath), "file");
  const seen = new Set<string>();

  const importRegex =
    /(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const spec = match[1]!;
    if (!spec.startsWith(".")) continue;
    const targetRel = resolveRelativeImport(spec, filePath, root);
    if (!targetRel) continue;
    const targetId = computeNodeId(targetRel, path.basename(targetRel), "file");
    if (targetId === fileId || seen.has(targetId)) continue;
    seen.add(targetId);
    edges.push({ source: fileId, target: targetId, type: "imports" });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function computeNodeId(nodePath: string, name: string, kind: CodeNodeKind): string {
  return createHash("sha256").update(`${nodePath}:${name}:${kind}`).digest("hex").slice(0, 32);
}

function extensionToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript",
    ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust",
    ".java": "java", ".kt": "kotlin",
  };
  return map[ext] ?? "unknown";
}
