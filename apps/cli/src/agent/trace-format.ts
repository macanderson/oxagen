/**
 * Plain-text rendering of a turn trace.
 *
 * The REPL renders a trace with Ink ({@link TraceView}); this module produces the
 * same information as plain text for the non-interactive `oxagen replay` command,
 * so the full chain of thought is inspectable in a pipe, a log, or CI. Kept pure
 * (no Ink, no AI SDK) so it is trivially testable.
 */
import { formatUsd } from "./model-router.js";
import type { TurnTrace } from "./trace.js";

function bar(score: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function bullets(items: string[], glyph = "-"): string {
  return items.map((i) => `    ${glyph} ${i}`).join("\n");
}

/** Render one trace as a human-readable, plain-text report. */
export function formatTraceText(trace: TurnTrace): string {
  const { evaluation: ev, enhancement: en } = trace;
  const lines: string[] = [];

  lines.push(
    `↻ replay ${trace.id} · ${Math.round(trace.durationMs / 100) / 10}s · ` +
      `${formatUsd(trace.usage.costUsd)} · ${trace.finalComplete ? "complete" : "gaps remain"}`,
  );

  lines.push("", "1 · Original prompt", `    ${trace.originalPrompt}`);

  lines.push(
    "",
    `2 · Evaluation${ev.fallback ? " (heuristic)" : ` · ${ev.model.split("/").pop()}`}`,
    `    completeness ${bar(ev.completeness)} ${ev.completeness}/100`,
    `    complexity   ${bar(ev.complexity)} ${ev.complexity}/100`,
  );
  if (ev.missing.length) lines.push("    missing from prompt:", bullets(ev.missing, "?"));
  if (ev.removed.length) lines.push("    pruned as low-value:", bullets(ev.removed, "−"));
  if (ev.reasoning) lines.push(`    ${ev.reasoning}`);

  if (ev.refinedPrompt !== trace.originalPrompt) {
    lines.push("", "3 · Refined prompt (noise removed)", `    ${ev.refinedPrompt}`);
  }

  lines.push("", `4 · Injected context · ${en.source}`);
  lines.push(
    en.resolved.length
      ? `    code refs: ${en.resolved.join(", ")}`
      : "    no code-graph references resolved",
  );
  lines.push(`    recalled lessons: ${en.lessonCount}`);

  lines.push(
    "",
    "5 · Model selected",
    `    ${trace.selectedModel.split("/").pop()} (${trace.selectedTier}) — ${trace.selectionRationale}`,
  );

  lines.push("", "6 · Completeness review (advisor)");
  if (trace.judgeRounds.length === 0) {
    lines.push("    not judged (bare mode)");
  } else {
    for (let i = 0; i < trace.judgeRounds.length; i++) {
      const v = trace.judgeRounds[i];
      if (!v) continue;
      lines.push(
        `    round ${i + 1}: ${v.complete ? "COMPLETE" : "INCOMPLETE"} · ` +
          `${v.confidence}% confident · advisor ${v.model.split("/").pop()}` +
          (v.fallback ? " (heuristic)" : ""),
      );
      if (v.findings.length) lines.push(bullets(v.findings, "✗"));
      if (v.reasoning) lines.push(`      ${v.reasoning}`);
    }
  }

  lines.push(
    "",
    `${trace.steps} steps · ${trace.filesTouched.length} file(s) touched` +
      (trace.filesTouched.length ? `: ${trace.filesTouched.slice(0, 5).join(", ")}` : ""),
  );

  return lines.join("\n");
}

/** Render a recent-turns list (newest first) as plain text. */
export function formatTraceList(traces: TurnTrace[]): string {
  if (traces.length === 0) return "No turns recorded yet.";
  return traces
    .map((t, i) => {
      const mark = t.finalComplete ? "✓" : "✗";
      const prompt =
        t.originalPrompt.length > 56 ? t.originalPrompt.slice(0, 56) + "…" : t.originalPrompt;
      return `${i + 1}. ${mark} ${prompt}  [${t.selectedModel.split("/").pop()} · ${formatUsd(t.usage.costUsd)}]`;
    })
    .join("\n");
}
