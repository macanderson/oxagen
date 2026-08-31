/**
 * Plain-text rendering of a turn trace.
 *
 * The REPL renders a trace with Ink ({@link TraceView}); this module produces the
 * same information as plain text for the non-interactive `oxagen replay` command,
 * so the full chain of thought is inspectable in a pipe, a log, or CI. Kept pure
 * (no Ink, no AI SDK) so it is trivially testable.
 */
import { formatUsd } from "./rate-card.js";
import type { PhaseStat, ToolEvent, TurnTrace } from "./trace.js";

function bar(score: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function bullets(items: string[], glyph = "-"): string {
  return items.map((i) => `    ${glyph} ${i}`).join("\n");
}

/** Compact ms → "340ms" / "1.2s". */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function shortModel(model: string | undefined): string {
  return model ? (model.split("/").pop() ?? model) : "—";
}

// Exported so a test can assert this Record<StageKind, ...> map stays exhaustive
// as the canonical StageKind union (re-exported from @oxagen/agent-engine via
// ./trace.js) evolves — see __tests__/stage-kind-exhaustive.test.ts.
/** Human label for a phase in the verbose breakdown. */
export const PHASE_LABEL: Record<PhaseStat["phase"], string> = {
  evaluate: "prompt eval",
  plan: "task plan",
  enhance: "context gather",
  route: "route",
  execute: "WORK (code)",
  judge: "REVIEW (judge)",
  revise: "revise",
  complete: "complete",
};

interface ModelRollup {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  phases: string[];
}

/** Group phases by the model that ran them — the "who spent what" headline. */
function rollupByModel(phases: PhaseStat[]): ModelRollup[] {
  const byModel = new Map<string, ModelRollup>();
  for (const p of phases) {
    if (!p.model) continue; // non-LLM phases (enhance/route) have no model
    const r = byModel.get(p.model) ?? {
      model: p.model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      phases: [],
    };
    r.inputTokens += p.usage.inputTokens;
    r.outputTokens += p.usage.outputTokens;
    r.costUsd += p.usage.costUsd;
    r.durationMs += p.durationMs;
    if (!r.phases.includes(PHASE_LABEL[p.phase]))
      r.phases.push(PHASE_LABEL[p.phase]);
    byModel.set(p.model, r);
  }
  return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
}

/** One line per tool call: name · duration · ok · input → result (truncated). */
function formatToolEvent(e: ToolEvent): string {
  const head = `    ${e.ok ? "·" : "✗"} ${e.name} (${fmtMs(e.durationMs)})  ${e.input}`;
  return e.result ? `${head}\n        → ${e.result}` : head;
}

/**
 * The verbose telemetry section: per-phase timing + model + cost, the per-model
 * rollup (who did the work vs the review vs the enhance and what each cost),
 * context-gather detail, the injected context, tool calls + results, and the
 * efficiency metrics that let you prove one run is faster/cheaper than another.
 */
export function formatVerboseSection(trace: TurnTrace): string[] {
  const lines: string[] = [];
  const phases = trace.phases ?? [];
  if (phases.length === 0 && !trace.toolEvents?.length) return lines;

  lines.push("", "── verbose telemetry ───────────────────────────────────");

  // Per-phase timeline.
  if (phases.length) {
    lines.push("", "phases (time · model · tokens in→out · cost)");
    for (const p of phases) {
      const round =
        p.phase === "execute" || p.phase === "judge" ? ` #${p.round + 1}` : "";
      const tok =
        p.usage.inputTokens || p.usage.outputTokens
          ? ` · ${p.usage.inputTokens}→${p.usage.outputTokens} tok · ${formatUsd(p.usage.costUsd)}`
          : "";
      lines.push(
        `    ${PHASE_LABEL[p.phase]}${round}  ${fmtMs(p.durationMs)} · ${shortModel(p.model)}${tok}`,
      );
    }
  }

  // The headline: which model spent which dollars on which role.
  const rollup = rollupByModel(phases);
  if (rollup.length) {
    lines.push("", "models used (role · time · tokens · cost)");
    for (const r of rollup) {
      lines.push(
        `    ${shortModel(r.model)} [${r.phases.join(", ")}]  ` +
          `${fmtMs(r.durationMs)} · ${r.inputTokens}→${r.outputTokens} tok · ${formatUsd(r.costUsd)}`,
      );
    }
  }

  // Context-gather detail.
  const en = trace.enhancement;
  if (en.retrieval || en.durationMs != null) {
    lines.push(
      "",
      `context gathering${en.durationMs != null ? ` · ${fmtMs(en.durationMs)}` : ""}`,
    );
    if (en.retrieval) {
      const r = en.retrieval;
      if (r.symbolsQueried.length)
        lines.push(`    symbols queried: ${r.symbolsQueried.join(", ")}`);
      if (r.pathsQueried.length)
        lines.push(`    paths queried:   ${r.pathsQueried.join(", ")}`);
      if (r.resolved.length)
        lines.push(`    resolved:        ${r.resolved.join(", ")}`);
      if (r.unresolved.length)
        lines.push(`    unresolved:      ${r.unresolved.join(", ")}`);
    }
    if (en.context) {
      lines.push("    injected context:");
      for (const l of en.context.split("\n")) lines.push(`      ${l}`);
    }
  }

  // Tool calls + results.
  const tools = trace.toolEvents ?? [];
  if (tools.length) {
    lines.push("", `tool calls (${tools.length})`);
    for (const e of tools) lines.push(formatToolEvent(e));
  }

  // Efficiency — the "prove it" numbers.
  const totalTok = trace.usage.inputTokens + trace.usage.outputTokens;
  const secs = trace.durationMs / 1000;
  lines.push(
    "",
    "efficiency",
    `    ${fmtMs(trace.durationMs)} total · ${totalTok} tok · ${formatUsd(trace.usage.costUsd)}`,
    `    ${secs > 0 ? Math.round(totalTok / secs) : 0} tok/s · ` +
      `${trace.steps} steps · ${trace.filesTouched.length} file(s) changed` +
      (trace.filesTouched.length
        ? ` · ${formatUsd(trace.usage.costUsd / trace.filesTouched.length)}/file`
        : ""),
  );

  return lines;
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
  if (ev.missing.length)
    lines.push("    missing from prompt:", bullets(ev.missing, "?"));
  if (ev.removed.length)
    lines.push("    pruned as low-value:", bullets(ev.removed, "−"));
  if (ev.reasoning) lines.push(`    ${ev.reasoning}`);

  if (ev.refinedPrompt !== trace.originalPrompt) {
    lines.push(
      "",
      "3 · Refined prompt (noise removed)",
      `    ${ev.refinedPrompt}`,
    );
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
      (trace.filesTouched.length
        ? `: ${trace.filesTouched.slice(0, 5).join(", ")}`
        : ""),
  );

  // Verbose turns carry the full per-phase / per-model / tool telemetry.
  if (trace.verbose || trace.phases?.length || trace.toolEvents?.length) {
    lines.push(...formatVerboseSection(trace));
  }

  return lines.join("\n");
}

/** Render a recent-turns list (newest first) as plain text. */
export function formatTraceList(traces: TurnTrace[]): string {
  if (traces.length === 0) return "No turns recorded yet.";
  return traces
    .map((t, i) => {
      const mark = t.finalComplete ? "✓" : "✗";
      const prompt =
        t.originalPrompt.length > 56
          ? t.originalPrompt.slice(0, 56) + "…"
          : t.originalPrompt;
      return `${i + 1}. ${mark} ${prompt}  [${t.selectedModel.split("/").pop()} · ${formatUsd(t.usage.costUsd)}]`;
    })
    .join("\n");
}
