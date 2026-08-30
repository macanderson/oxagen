/**
 * Formatters that turn a {@link GraphResult} into (a) the JSON string the
 * `graph_query` tool returns to the model and (b) a compact text block folded
 * into worker / prompt-enhancer prompts. Keeping both here means the tool output
 * and the prompt context never drift.
 */
import type { GraphResult } from "./context-resolver.js";

/** The exact JSON payload the `graph_query` tool returns. */
export function formatGraphResultJson(result: GraphResult): string {
  return JSON.stringify(
    {
      impactedFiles: result.impactedFiles,
      symbols: result.symbols,
      edges: result.edges,
      coverage: result.coverage,
    },
    null,
    2,
  );
}

/**
 * A compact, human-readable context block for worker prompts. Returns `""` when
 * the result is empty so the caller can cleanly skip an empty section. Workers
 * receive the impacted files, the key symbols, and the edges that connect them —
 * the structured context that replaces a flurry of greps.
 */
export function formatGraphContextForPrompt(result: GraphResult): string {
  if (result.impactedFiles.length === 0 && result.symbols.length === 0)
    return "";
  const lines: string[] = [
    "Code-graph context (query the graph before grepping):",
  ];

  if (result.impactedFiles.length > 0) {
    lines.push("", "Impacted files:");
    for (const f of result.impactedFiles)
      lines.push(`- ${f.path} — ${f.reason}`);
  }
  if (result.symbols.length > 0) {
    lines.push("", "Key symbols:");
    for (const s of result.symbols.slice(0, 40)) {
      const kind = s.kind ? `${s.kind} ` : "";
      const loc = s.line ? `:${s.line}` : "";
      lines.push(`- ${kind}${s.name} (${s.file}${loc})`);
    }
  }
  if (result.edges.length > 0) {
    lines.push("", "Relationships:");
    for (const e of result.edges.slice(0, 40))
      lines.push(`- ${e.from} —${e.type}→ ${e.to}`);
  }
  lines.push("", `Graph coverage: ${result.coverage.toFixed(2)}`);
  return lines.join("\n");
}
