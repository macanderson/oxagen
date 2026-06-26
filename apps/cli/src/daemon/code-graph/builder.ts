/**
 * Code graph builder — constructs the initial code graph from a workspace
 * by walking files and extracting symbols.
 *
 * Uses a simplified AST-like extraction (no tree-sitter dep for now).
 * In production, tree-sitter parsers from packages/ingestion would be used.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { CodeGraph, CodeNode, CodeEdge, CodeNodeKind } from "./types";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "coverage",
  ".turbo", ".vercel", "__pycache__",
]);

/**
 * Build a code graph from a workspace root directory.
 */
export async function buildCodeGraph(workspaceRoot: string): Promise<CodeGraph> {
  const graph: CodeGraph = { nodes: new Map(), edges: [] };
  await walkDirectory(workspaceRoot, workspaceRoot, graph);
  return graph;
}

async function walkDirectory(dir: string, root: string, graph: CodeGraph): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDirectory(fullPath, root, graph);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
      await processFile(fullPath, root, graph);
    }
  }
}

async function processFile(filePath: string, root: string, graph: CodeGraph): Promise<void> {
  const relativePath = path.relative(root, filePath);
  const ext = path.extname(filePath);
  const language = extensionToLanguage(ext);

  // Create file node
  const fileNode: CodeNode = {
    id: computeNodeId(relativePath, path.basename(filePath), "file"),
    kind: "file",
    name: path.basename(filePath),
    path: relativePath,
    range: { start: 0, end: 0 },
    language,
  };
  graph.nodes.set(fileNode.id, fileNode);

  // Extract symbols from the file
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const symbols = extractSymbols(content, relativePath, language);

    for (const symbol of symbols) {
      graph.nodes.set(symbol.id, symbol);
      // File contains the symbol
      graph.edges.push({ source: fileNode.id, target: symbol.id, type: "contains" });
    }

    // Extract imports
    const imports = extractImports(content, relativePath, language);
    graph.edges.push(...imports);
  } catch {
    // Skip files that can't be read
  }
}

/**
 * Extract symbol definitions from file content.
 * Simplified regex-based extraction — tree-sitter in production.
 */
function extractSymbols(content: string, filePath: string, language: string): CodeNode[] {
  const symbols: CodeNode[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Function declarations
    const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (fnMatch) {
      symbols.push({
        id: computeNodeId(filePath, fnMatch[1]!, "function"),
        kind: "function",
        name: fnMatch[1]!,
        path: filePath,
        range: { start: i + 1, end: findEndLine(lines, i) },
        language,
        signature: line.trim(),
      });
    }

    // Class declarations
    const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      symbols.push({
        id: computeNodeId(filePath, classMatch[1]!, "class"),
        kind: "class",
        name: classMatch[1]!,
        path: filePath,
        range: { start: i + 1, end: findEndLine(lines, i) },
        language,
        signature: line.trim(),
      });
    }

    // Interface/type declarations
    const typeMatch = line.match(/(?:export\s+)?(?:interface|type)\s+(\w+)/);
    if (typeMatch) {
      symbols.push({
        id: computeNodeId(filePath, typeMatch[1]!, "type"),
        kind: "type",
        name: typeMatch[1]!,
        path: filePath,
        range: { start: i + 1, end: findEndLine(lines, i) },
        language,
      });
    }
  }

  return symbols;
}

/**
 * Extract import edges from file content.
 */
function extractImports(content: string, filePath: string, _language: string): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const fileId = computeNodeId(filePath, path.basename(filePath), "file");

  // Match import statements
  const importRegex = /import\s+.*?from\s+["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1]!;
    // Only track relative imports (skip node_modules)
    if (importPath.startsWith(".") || importPath.startsWith("@")) {
      const targetId = computeNodeId(importPath, path.basename(importPath), "file");
      edges.push({ source: fileId, target: targetId, type: "imports" });
    }
  }

  return edges;
}

function computeNodeId(path: string, name: string, kind: CodeNodeKind): string {
  return createHash("sha256").update(`${path}:${name}:${kind}`).digest("hex").slice(0, 32);
}

function findEndLine(lines: string[], startLine: number): number {
  let braceCount = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const char of lines[i]!) {
      if (char === "{") { braceCount++; started = true; }
      if (char === "}") { braceCount--; }
      if (started && braceCount === 0) return i + 1;
    }
  }
  return startLine + 1;
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
