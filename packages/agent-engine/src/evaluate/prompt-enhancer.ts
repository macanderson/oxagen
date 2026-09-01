/**
 * Automatic prompt enhancement.
 *
 * Before a prompt is handed to the agent (or split into a plan), this enriches it
 * with the recalled memory context the engine already has: the gotchas it learned
 * last time, and the repository prior when one is configured. The user types "fix
 * the login bug"; the agent receives that plus what past sessions discovered.
 *
 * The module uses the engine's injected {@link MemoryProvider} port rather than
 * reaching for a concrete store, so the CLI and the platform share one
 * implementation.
 */
import type { MemoryProvider } from "../ports";
import { loadPrior, renderPrior } from "../priors";
import {
  filterRecall,
  tagRecall,
  type RecallItem,
} from "../memory/applicability";

export interface EnhanceOptions {
  prompt: string;
  /**
   * Memory provider for recalled lessons. When omitted, memory enrichment is
   * skipped. Calls `recallContext()` to get a pre-formatted context string.
   */
  memory?: MemoryProvider | null;
  /** Repository identifier for F8 repo-prior lookup (e.g., "django/django"). */
  repo?: string;
  /** Base directory for F8 repo-prior files (e.g., ~/.oxagen/repo-priors). */
  priorsDir?: string;
}

export interface EnhanceResult {
  /** The original prompt with the retrieved context appended. */
  prompt: string;
  /** The retrieved context block alone (empty if nothing was found). */
  context: string;
  /** Whether any memory context was injected. */
  hasMemory: boolean;
  /** Whether F8 repo prior was injected. */
  hasRepoPrior: boolean;
  /** Whether F9 memory recall filtering was applied. */
  filteredRecall: boolean;
  /** Epoch ms context-gathering started. */
  startedAt: number;
  /** Epoch ms context-gathering finished. */
  finishedAt: number;
  /** Wall-clock ms spent gathering + injecting context. */
  durationMs: number;
}

export async function enhancePrompt(
  opts: EnhanceOptions,
): Promise<EnhanceResult> {
  const { prompt, memory } = opts;
  const startedAt = Date.now();

  const sections: string[] = [];
  let hasRepoPrior = false;
  let filteredRecall = false;

  // ── F8: Repo prior injection ──────────────────────────────────────────────

  if (opts.repo && opts.priorsDir && process.env.OXAGEN_REPO_PRIORS === "1") {
    try {
      const prior = loadPrior(opts.priorsDir, opts.repo);
      if (prior) {
        const rendered = renderPrior(prior);
        if (rendered.length > 0) {
          sections.push(rendered);
          hasRepoPrior = true;
        }
      }
    } catch {
      /* prior loading is optional; graceful degradation */
    }
  }

  // ── Memory context recall ──────────────────────────────────────────────────

  let rawMemoryContext = "";
  let hasMemory = false;
  if (memory) {
    try {
      rawMemoryContext = await memory.recallContext();
      hasMemory = rawMemoryContext.trim().length > 0;
    } catch {
      /* memory recall is optional — enhancement degrades gracefully */
    }
  }

  // ── F9: Memory-recall applicability filter ─────────────────────────────────

  let memoryContext = rawMemoryContext;
  if (hasMemory && process.env.OXAGEN_RECALL_FILTER === "1") {
    try {
      // Parse raw memory into RecallItems (lines starting with "- " are new items).
      const items: RecallItem[] = [];
      let currentItem: RecallItem | null = null;
      for (const line of rawMemoryContext.split("\n")) {
        if (line.startsWith("- ")) {
          const id = `r${items.length + 1}`;
          currentItem = { id, text: line.slice(2).trim() };
          items.push(currentItem);
        } else if (line.trim() && currentItem) {
          currentItem.text += " " + line.trim();
        }
      }

      // Stage 1 (lexical) only — stage 2's scorer stays null. Nothing supplies
      // candidate files: the agent locates code itself with `grep`/`read_file`,
      // so applicability is judged against the issue text alone.
      const filtered = await filterRecall(
        items,
        { issue: prompt, candidateFiles: [] },
        null,
      );
      const taggedRecall = tagRecall(filtered);
      memoryContext = taggedRecall;
      filteredRecall = true;
    } catch {
      /* filtering is optional; fall back to raw memory */
    }
  }

  const parts: string[] = [];
  if (sections.length > 0) {
    parts.push(sections.join("\n\n"));
  }
  if (hasMemory && memoryContext) {
    parts.push(
      filteredRecall
        ? memoryContext
        : "## Recalled context (from prior sessions)\n" + memoryContext,
    );
  }

  const context = parts.join("\n\n");
  const enhanced = context ? `${prompt}\n\n${context}` : prompt;

  const finishedAt = Date.now();

  return {
    prompt: enhanced,
    context,
    hasMemory,
    hasRepoPrior,
    filteredRecall,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  };
}
