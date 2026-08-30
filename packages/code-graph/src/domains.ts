/**
 * LLM-inferred domain tagging for code-graph nodes.
 *
 * This module is intentionally dependency-light (zod only, no platform AI
 * imports) so the local CLI can classify a checkout without pulling in
 * platform metering, ClickHouse, or tenancy infrastructure.
 *
 * The AI call is injected by the local CLI caller.
 *
 * The resulting application-domain slug (for example `payments` or `auth`) is
 * stored only on local DuckDB code nodes. It never flows into the shared
 * Oxagen workspace graph.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal injectable AI interface for domain inference.
 *
 * Both the platform's `generateObjectFor` and the AI SDK's `generateObject`
 * satisfy this interface when wrapped by the caller (they both return
 * `{ object: T }` for schema-validated structured output).
 */
export interface DomainAI {
  generateObject<T>(args: {
    /** Zod schema the model must conform to. */
    schema: z.ZodType<T>;
    /** Single-string system instruction. */
    system: string;
    /** Single-turn user prompt. */
    prompt: string;
  }): Promise<{ object: T }>;
}

/** Input for a single `inferDomains` call. */
export interface DomainInferInput {
  /**
   * All relative file paths to classify.
   * Any file missing from this list will not appear in the output map.
   */
  files: string[];
  /**
   * Top-level directory names (first path segment, deduped).
   * Derived from `files` if omitted — pass explicitly for a slightly richer
   * prompt when the full directory list is already available.
   */
  dirs?: string[];
  /**
   * Representative symbol names to give the model richer semantic context.
   * Optional — domain inference works from paths alone when omitted.
   */
  symbols?: Array<{ name: string; path: string; kind: string }>;
}

/**
 * Maps relative file path → inferred domain slug (e.g. "payments", "auth").
 *
 * Only files that received a confident domain assignment are included.
 * Missing keys should be treated as domain = "unknown" by the caller.
 */
export type DomainMap = Map<string, string>;

// ---------------------------------------------------------------------------
// Internal schema
// ---------------------------------------------------------------------------

const domainInferenceSchema = z.object({
  domains: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "Short, lowercase, kebab-case domain slug — e.g. 'payments', 'auth', 'billing'",
          ),
        description: z
          .string()
          .describe(
            "One sentence describing what functionality this domain covers.",
          ),
        filePaths: z
          .array(z.string())
          .describe(
            "Relative file paths (using the EXACT strings from the input list) " +
              "that belong to this domain.",
          ),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20),
});

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Minimum LLM confidence to accept a domain assignment. */
const CONFIDENCE_THRESHOLD = 0.55;

/** Cap on files included in the prompt (token budget control). */
const MAX_FILES_IN_PROMPT = 300;

/** Cap on symbols included in the prompt (token budget control). */
const MAX_SYMBOLS_IN_PROMPT = 150;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Infer application domains from workspace structure using an injected AI.
 *
 * The function batches ALL files into a SINGLE model call (not per-file) so
 * the model sees the full directory structure and can reason holistically —
 * this is the right granularity for domain classification.
 *
 * Returns a `DomainMap` of file path → domain slug for every file that
 * received a high-confidence (≥ 0.55) assignment. Files without a confident
 * assignment are absent from the map — callers should treat them as "unknown".
 *
 * Only the first {@link MAX_FILES_IN_PROMPT} entries of `input.files` are shown
 * to the model, so a checkout larger than that gets domains for that prefix and
 * nothing else. There is no batching across several calls: pass a pre-filtered
 * or pre-sampled file list if the whole tree has to be covered.
 *
 * @example Platform (metered, ingestion surface)
 * ```ts
 * const map = await inferDomains(input, {
 *   generateObject: (args) =>
 *     generateObjectFor({
 *       ...args,
 *       telemetry: { orgId, workspaceId, surface: "ingestion", messageId: null },
 *     }),
 * });
 * ```
 *
 * @example CLI (AI Gateway, BYOK)
 * ```ts
 * const map = await inferDomains(input, {
 *   generateObject: (args) => generateObject({ model: gatewayModel, ...args }),
 * });
 * ```
 */
export async function inferDomains(
  input: DomainInferInput,
  ai: DomainAI,
): Promise<DomainMap> {
  if (input.files.length === 0) return new Map();

  // Fast-lookup set so path validation is O(1) per file.
  const fileSet = new Set(input.files);

  // Derive top-level dirs from file paths when not supplied.
  const dirs = input.dirs ?? [
    ...new Set(
      input.files
        .map((f) => f.split("/")[0])
        .filter((d): d is string => Boolean(d)),
    ),
  ];

  const fileSample = input.files.slice(0, MAX_FILES_IN_PROMPT);
  const symbolSample = (input.symbols ?? []).slice(0, MAX_SYMBOLS_IN_PROMPT);

  const prompt =
    `Analyse this repository layout and identify its application domains.\n\n` +
    `Top-level directories (${dirs.length}):\n` +
    dirs.map((d) => `  ${d}`).join("\n") +
    `\n\nFile paths (${fileSample.length} of ${input.files.length} total):\n` +
    fileSample.map((f) => `  ${f}`).join("\n") +
    (symbolSample.length > 0
      ? `\n\nRepresentative symbols:\n` +
        symbolSample.map((s) => `  ${s.kind} ${s.name}  (${s.path})`).join("\n")
      : "") +
    `\n\nFor each domain, list EVERY file path from the list above that belongs ` +
    `to it. Use the EXACT path strings from the file list. ` +
    `Each file should belong to exactly one domain.`;

  const result = await ai.generateObject({
    schema: domainInferenceSchema,
    system:
      "You are a senior software architect. Analyse a codebase and group its files " +
      "into logical application domains (e.g. 'payments', 'auth', 'billing', " +
      "'knowledge-graph', 'ingestion', 'notifications', 'api', 'ui', 'shared'). " +
      "Use short, lowercase, kebab-case slugs for domain names. " +
      "Be decisive — assign every parseable file to a domain. " +
      "Only omit files you genuinely cannot classify. " +
      "Do NOT create a catch-all 'misc' or 'other' domain.",
    prompt,
  });

  const domainMap: DomainMap = new Map();
  for (const domain of result.object.domains) {
    if (domain.confidence < CONFIDENCE_THRESHOLD) continue;
    for (const fp of domain.filePaths) {
      // Guard: only accept paths that were in the original input.
      if (fileSet.has(fp)) {
        domainMap.set(fp, domain.name);
      }
    }
  }

  return domainMap;
}
