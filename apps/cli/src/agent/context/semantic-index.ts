/**
 * Semantic index over the local code graph (Group 3 context layer).
 *
 * Ranks a repo's *file* nodes by cosine similarity to a natural-language query,
 * so `graph_query` can answer "show me the code related to telemetry drains"
 * with the actually-relevant files instead of a name-substring guess. File nodes
 * are the unit the graph contract ranks ("impacted files"); symbols and edges are
 * then pulled in structurally by the traversal layer.
 *
 * Embedding is lazy and cached: on first use a file node is embedded with the
 * shared `renderFileText` and the vector is persisted on the local DuckDB node.
 * Subsequent queries reuse it, and
 * only files whose vector is missing or was produced by a different model are
 * re-embedded — so the cost is paid once, incrementally.
 *
 * When no embedding client is available (offline / no gateway key) this module
 * is skipped entirely and the caller falls back to lexical + traversal.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cosineSimilarity,
  renderFileText,
  renderMarkdownFileText,
} from "@oxagen/code-graph";
import type { CodeGraph, CodeNode } from "../../daemon/code-graph/types.js";
import type { CodeGraphStore } from "../../daemon/code-graph/store.js";
import type { EmbeddingClient } from "./embedding.js";

/** A file ranked by semantic similarity to the query. */
export interface RankedFile {
  fileId: string;
  path: string;
  score: number;
}

/** Safety cap on how many files a single lazy indexing pass will embed. */
const MAX_EMBED_PER_PASS = 1500;

/** The symbol names a file directly contains (for the file's embed text). */
function symbolNamesInFile(graph: CodeGraph, fileId: string): string[] {
  const names: string[] = [];
  for (const e of graph.edges) {
    if (e.source !== fileId || e.type !== "contains") continue;
    const sym = graph.nodes.get(e.target);
    if (sym) names.push(sym.name);
  }
  return names;
}

/** Read a file's text, returning null on any I/O error (deleted, binary, perms). */
async function safeRead(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

export interface EnsureEmbeddingsParams {
  graph: CodeGraph;
  /** Absolute workspace root — file node paths are relative to it. */
  root: string;
  client: EmbeddingClient;
  /** Optional DuckDB store to persist vectors into (skip in pure unit tests). */
  store?: CodeGraphStore | null;
  /** Injectable file reader (tests). Defaults to reading from disk. */
  readFileText?: (absPath: string) => Promise<string | null>;
  /** Cap on files embedded in this pass. Defaults to {@link MAX_EMBED_PER_PASS}. */
  maxFiles?: number;
}

/** Outcome of an embedding pass — enough for the caller to log coverage. */
export interface EnsureEmbeddingsResult {
  /** fileId → vector, for every file node that now has a usable vector. */
  vectors: Map<string, number[]>;
  /** How many files were embedded this pass (network calls). */
  embedded: number;
  /** How many were reused from a persisted vector. */
  reused: number;
  /** True when the cap truncated the pass (some files left un-embedded). */
  truncated: boolean;
}

/**
 * Ensure every file node has a vector for the active client, embedding the ones
 * that don't (and persisting them). Returns the fileId→vector map used for
 * ranking. Mutates the in-memory graph nodes so a long-lived process reuses the
 * vectors without another store round-trip.
 */
export async function ensureFileEmbeddings(
  params: EnsureEmbeddingsParams,
): Promise<EnsureEmbeddingsResult> {
  const { graph, root, client, store } = params;
  const read = params.readFileText ?? safeRead;
  const cap = params.maxFiles ?? MAX_EMBED_PER_PASS;

  const vectors = new Map<string, number[]>();
  const toEmbed: { node: CodeNode; text: string }[] = [];
  let reused = 0;
  let truncated = false;

  for (const node of graph.nodes.values()) {
    if (node.kind !== "file") continue;
    // Reuse a persisted vector only if it came from the active model.
    if (
      node.embedding &&
      node.embedding.length === client.dimensions &&
      node.embeddingProvider === client.providerId
    ) {
      vectors.set(node.id, node.embedding);
      reused++;
      continue;
    }
    if (toEmbed.length >= cap) {
      truncated = true;
      continue;
    }
    const content = await read(join(root, node.path));
    if (content === null) continue; // unreadable — no vector, ranked out
    // Docs get the full-content-aware renderer (chunked, no symbol list to
    // lean on); code gets the head-slice + symbol-name renderer.
    const text =
      node.language === "markdown"
        ? renderMarkdownFileText({ path: node.path, content })
        : renderFileText({
            path: node.path,
            language: node.language,
            content,
            symbolNames: symbolNamesInFile(graph, node.id),
          });
    toEmbed.push({ node, text });
  }

  let embedded = 0;
  if (toEmbed.length > 0) {
    const fresh = await client.embedBatch(toEmbed.map((t) => t.text));
    const persist = new Map<string, { vector: number[]; provider: string }>();
    for (let i = 0; i < toEmbed.length; i++) {
      const vec = fresh[i];
      const node = toEmbed[i]!.node;
      if (!vec || vec.length !== client.dimensions) continue;
      vectors.set(node.id, vec);
      node.embedding = vec;
      node.embeddingProvider = client.providerId;
      persist.set(node.id, { vector: vec, provider: client.providerId });
      embedded++;
    }
    if (store && persist.size > 0) {
      await store.updateNodeEmbeddings(root, persist);
    }
  }

  return { vectors, embedded, reused, truncated };
}

/**
 * Rank file nodes by cosine similarity to `queryVector`. Only files present in
 * `vectors` are considered; returns the top `limit` with a score > 0, highest
 * first.
 */
export function rankFilesBySimilarity(
  graph: CodeGraph,
  queryVector: number[],
  vectors: Map<string, number[]>,
  limit: number,
): RankedFile[] {
  const ranked: RankedFile[] = [];
  for (const [fileId, vec] of vectors) {
    const score = cosineSimilarity(queryVector, vec);
    if (score <= 0) continue;
    const node = graph.nodes.get(fileId);
    if (!node) continue;
    ranked.push({ fileId, path: node.path, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}
