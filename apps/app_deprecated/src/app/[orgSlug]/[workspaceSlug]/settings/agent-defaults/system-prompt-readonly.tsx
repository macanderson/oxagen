/**
 * system-prompt-readonly.tsx — read-only display of the workspace's effective
 * agent system prompt.
 *
 * Shows the fully-resolved `chat.system` prompt (the platform's append-only
 * orchestration baseline + this workspace's appended Additional instructions).
 * The core orchestration prompt is intentionally NOT editable here — per the
 * prompt registry's OVERRIDABLE_PROMPT_KEYS policy `chat.system` is append-only,
 * so a replacement would silently break tool-calling / inline-UI / workflow
 * contracts. This surface exists purely for transparency: admins can see exactly
 * what their agent is instructed to do, and append via Additional instructions.
 *
 * Server component (no client state) — read-only by construction.
 */
import { Badge } from "@/components/ui/badge";

export interface SystemPromptReadonlyProps {
  /** Fully-resolved chat.system prompt (baseline + appended workspace instructions). */
  prompt: string;
}

export function SystemPromptReadonly({ prompt }: SystemPromptReadonlyProps) {
  return (
    <section aria-labelledby="system-prompt-heading">
      <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
        System prompt
      </p>
      <details className="group rounded-lg border border-border/60 bg-card">
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-foreground">
          <span className="flex items-center gap-2">
            <span id="system-prompt-heading">
              Effective workspace system prompt
            </span>
            <Badge variant="secondary" size="sm">
              Read-only
            </Badge>
          </span>
          <span className="text-xs text-muted-foreground">Click to expand</span>
        </summary>
        <div className="border-t border-border/40 px-4 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            This is the exact instruction set your agent runs with in this
            workspace — Oxagen&apos;s core orchestration prompt with your{" "}
            <span className="font-medium text-foreground">
              Additional instructions
            </span>{" "}
            (below) appended. The core prompt is managed by Oxagen and is not
            editable; use Additional instructions to add workspace-wide context.
          </p>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {prompt}
          </pre>
        </div>
      </details>
    </section>
  );
}
