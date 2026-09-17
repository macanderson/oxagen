"use client";

import { Copy, Check, Terminal } from "lucide-react";
import { useCopyToClipboard } from "@/components/ui/copy-button";

interface InstallStep {
  label: string;
  command?: string;
}

export interface InstallInstructionsProps {
  /** The AI client these instructions target. */
  client: string;
  /** Ordered list of installation steps. */
  steps: InstallStep[];
}

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  codex: "OpenAI Codex CLI",
  vscode: "VS Code",
};

interface CopyButtonProps {
  text: string;
  label: string;
}

function CopyButton({ text, label }: CopyButtonProps) {
  const { copied, copy } = useCopyToClipboard({ timeout: 2000 });

  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="size-3.5 text-foreground" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Renders branded MCP/CLI installation steps for a given AI client.
 * Each step with a command shows the command in a code block with a
 * copy-to-clipboard button. Prose-only steps render as plain list items.
 */
export default function InstallInstructions({
  client,
  steps,
}: InstallInstructionsProps) {
  const clientLabel = CLIENT_LABELS[client] ?? client;

  return (
    <div
      className="rounded-2xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden"
      role="region"
      aria-label={`Install Oxagen for ${clientLabel}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-muted/40 dark:bg-muted/20">
        <div className="rounded-md bg-muted p-1.5">
          <Terminal
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
            Install
          </p>
          <p className="text-sm font-medium text-foreground leading-tight">
            Oxagen for {clientLabel}
          </p>
        </div>
      </div>

      {/* Steps list */}
      <ol className="divide-y divide-border" aria-label="Installation steps">
        {steps.map((step, index) => (
          <li key={index} className="px-4 py-3">
            {/* Step number + label */}
            <div className="flex items-start gap-2.5 mb-2">
              <span
                className="flex-shrink-0 flex items-center justify-center size-5 rounded-full bg-muted text-muted-foreground text-xs font-semibold mt-0.5"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <p className="text-sm text-foreground leading-snug">
                {step.label}
              </p>
            </div>

            {/* Command block — only rendered when a command is present */}
            {step.command && (
              <div className="ml-7 flex items-start gap-2 rounded-lg bg-muted/60 dark:bg-muted/30 border border-border px-3 py-2.5 group">
                <pre className="flex-1 text-xs font-mono text-foreground whitespace-pre-wrap break-all leading-relaxed overflow-x-auto">
                  {step.command}
                </pre>
                <CopyButton
                  text={step.command}
                  label={`step ${index + 1} command`}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
