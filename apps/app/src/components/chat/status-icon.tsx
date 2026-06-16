"use client";
import * as React from "react";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallStatus } from "./stream-event-types";

/**
 * StatusIcon — shared status indicator used by ToolCallCard and CodeExecuteCard.
 * Renders a pulsing dot while the model is still composing the call's arguments
 * (pending), a spinner while executing (running), a check for completed, or an
 * X for failed.
 */
export function StatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === "pending") {
    // Args still streaming in — a soft pulsing dot reads as "composing".
    return (
      <span
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-info"
        aria-label="Composing"
      />
    );
  }
  if (status === "running") {
    return <Loader2 className={cn("h-3.5 w-3.5 animate-spin text-foreground")} aria-label="Running" />;
  }
  if (status === "completed") {
    return <Check className="h-3.5 w-3.5 text-success" aria-label="Completed" />;
  }
  return <X className="h-3.5 w-3.5 text-destructive" aria-label="Failed" />;
}
