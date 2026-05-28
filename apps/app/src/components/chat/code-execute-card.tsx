"use client";
import * as React from "react";
import { Check, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatDuration } from "./tool-call-card";
import type { ToolCallStatus } from "./stream-event-types";

export interface CodeExecuteCardProps {
  toolCallId: string;
  language: "node" | "python" | "shell" | string;
  code: string;
  status: ToolCallStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  oomKilled?: boolean;
  durationMs?: number;
}

// Specialized variant of `tool-call-card.tsx` for `agent.code.execute`.
// Renders the code block prominently with tabbed stdout/stderr panes and
// a result strip showing exit code + OOM flag. Reuses the same status icon
// language as ToolCallCard so the two read as a family.
export function CodeExecuteCard({
  language,
  code,
  status,
  stdout,
  stderr,
  exitCode,
  oomKilled,
  durationMs,
}: CodeExecuteCardProps) {
  const stdoutRef = React.useRef<HTMLPreElement>(null);
  const stderrRef = React.useRef<HTMLPreElement>(null);

  React.useEffect(() => {
    if (status !== "running") return;
    if (stdoutRef.current) stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
    if (stderrRef.current) stderrRef.current.scrollTop = stderrRef.current.scrollHeight;
  }, [stdout, stderr, status]);

  return (
    <div className="glass-panel my-2 space-y-3 p-3 text-sm animate-in">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono">
          agent.code.execute
        </Badge>
        <Badge variant="muted" className="uppercase">
          {language}
        </Badge>
        <StatusIcon status={status} />
        {durationMs != null && status !== "running" ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </div>

      <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>

      <Tabs defaultValue="stdout">
        <TabsList>
          <TabsTrigger value="stdout">stdout</TabsTrigger>
          <TabsTrigger value="stderr">stderr</TabsTrigger>
        </TabsList>
        <TabsContent value="stdout">
          <pre
            ref={stdoutRef}
            className="max-h-64 overflow-y-auto rounded-lg bg-black/85 p-2 font-mono text-xs text-emerald-200"
          >
            {stdout ?? (status === "running" ? "Waiting for output…" : "")}
          </pre>
        </TabsContent>
        <TabsContent value="stderr">
          <pre
            ref={stderrRef}
            className="max-h-64 overflow-y-auto rounded-lg bg-black/85 p-2 font-mono text-xs text-rose-300"
          >
            {stderr ?? ""}
          </pre>
        </TabsContent>
      </Tabs>

      {status !== "running" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge
            variant={exitCode === 0 ? "success" : "destructive"}
            className="tabular-nums"
          >
            exit {exitCode ?? "?"}
          </Badge>
          {oomKilled ? <Badge variant="destructive">OOM killed</Badge> : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
  if (status === "completed") return <Check className="h-3.5 w-3.5 text-emerald-500" />;
  return <X className="h-3.5 w-3.5 text-destructive" />;
}
