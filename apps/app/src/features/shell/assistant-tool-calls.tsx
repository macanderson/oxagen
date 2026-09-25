"use client";
// The tool calls behind one assistant reply (#4161). The list sits closed under
// the reply, one line per call: the tool's label, its outcome and how long it
// took. Opening a line shows the raw tool name, the call id and, for a parked
// call, the approval id, each selectable so a person can copy it into a search.
//
// The list arrives whole with the reply, because a reply does not stream yet
// (#4204). A reply restored after a reload lists the calls `get_conversation`
// read from its run.
import { useLocale, useTranslations } from "next-intl";
import type { ToolCallSummary } from "./assistant-stream-client";
import { mono } from "@/ui/control-styles";
import { formatDuration } from "@/ui/money-format";

/**
 * Each outcome's message key, spelled out so the typed catalogue checks every
 * one of them.
 */
const OUTCOME_KEY = {
  completed: "toolCalls.outcome.completed",
  failed: "toolCalls.outcome.failed",
  denied: "toolCalls.outcome.denied",
  cancelled: "toolCalls.outcome.cancelled",
  parked: "toolCalls.outcome.parked",
} as const satisfies Record<ToolCallSummary["outcome"], string>;

/** Outcomes a person should notice: they did not do what the reply may imply. */
const NOTICE: ReadonlySet<ToolCallSummary["outcome"]> = new Set([
  "failed",
  "denied",
  "parked",
]);

const copyable = `${mono} select-all break-all text-foreground`;

/**
 * A tool's name as a person reads it: `list_runs` reads "List runs".
 * The raw name stays in the call's detail.
 *
 * @internal Exported for its unit test.
 */
export function toolLabel(name: string): string {
  const words = name.split(/[_.]+/).filter((word) => word.length > 0);
  if (words.length === 0) return name;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function AssistantToolCalls({
  calls,
}: {
  calls: readonly ToolCallSummary[];
}) {
  const t = useTranslations("shell.assistant");
  const locale = useLocale();
  if (calls.length === 0) return null;
  return (
    <details
      data-testid="assistant-tool-calls"
      className="mt-1.5 text-[12px] text-muted-foreground"
    >
      <summary className="w-fit cursor-pointer select-none">
        {t("toolCalls.summary", { count: calls.length })}
      </summary>
      <ol className="mt-1 flex flex-col gap-1">
        {calls.map((call) => (
          <li
            key={call.toolCallId}
            data-testid="assistant-tool-call"
            data-outcome={call.outcome}
          >
            <details className="group rounded-md border border-border bg-app-raised-bg px-2 py-1 text-app-raised-fg">
              {/* A flex summary loses the native marker, so it draws its own: `▸`, `▾` when open. */}
              <summary className="flex cursor-pointer list-none items-baseline gap-2 before:flex-none before:text-muted-foreground before:content-['▸'] group-open:before:content-['▾'] [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1 truncate">
                  {toolLabel(call.toolName)}
                </span>
                <span
                  data-testid="assistant-tool-call-outcome"
                  className={
                    NOTICE.has(call.outcome)
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {t(OUTCOME_KEY[call.outcome])}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatDuration(call.durationMs, locale)}
                </span>
              </summary>
              <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                <dt>{t("toolCalls.tool")}</dt>
                <dd className={copyable}>{call.toolName}</dd>
                <dt>{t("toolCalls.callId")}</dt>
                <dd className={copyable}>{call.toolCallId}</dd>
                {call.approvalId === null ? null : (
                  <>
                    <dt>{t("toolCalls.approvalId")}</dt>
                    <dd
                      data-testid="assistant-tool-call-approval"
                      className={copyable}
                    >
                      {call.approvalId}
                    </dd>
                  </>
                )}
              </dl>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}
