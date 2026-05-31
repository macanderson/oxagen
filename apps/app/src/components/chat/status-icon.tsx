"use client";
import * as React from "react";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallStatus } from "./stream-event-types";

/**
 * StatusIcon — shared status indicator used by ToolCallCard and CodeExecuteCard.
 * Renders a spinner for running, a check for completed, or an X for failed/other.
 */
export function StatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === "running") {
    return <Loader2 className={cn("h-3.5 w-3.5 animate-spin text-accent")} aria-label="Running" />;
  }
  if (status === "completed") {
    return <Check className="h-3.5 w-3.5 text-emerald-500" aria-label="Completed" />;
  }
  return <X className="h-3.5 w-3.5 text-destructive" aria-label="Failed" />;
}
