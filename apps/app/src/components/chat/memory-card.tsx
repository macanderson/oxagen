"use client";
import * as React from "react";
import { Brain } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { MemoryRecallHit } from "./stream-event-types";

export interface MemoryCardProps {
  queryId: string;
  memories: MemoryRecallHit[];
  topN?: number;
}

const WEIGHT_VARIANT: Record<string, "success" | "warn" | "muted" | "default"> = {
  fact: "success",
  consider: "warn",
  ignore: "muted",
};

export function MemoryCard({ memories, topN = 5 }: MemoryCardProps) {
  const top = memories.slice(0, topN);
  if (top.length === 0) return null;
  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 space-y-2 p-3 text-sm animate-in"
      data-component="memory-card"
    >
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold">Recalled memories</span>
        <Badge variant="muted" className="ml-auto tabular-nums">
          {memories.length}
        </Badge>
      </div>
      <ul className="space-y-2">
        {top.map((m) => (
          <li key={m.id} className="rounded-xl bg-muted p-2 text-xs">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant={WEIGHT_VARIANT[m.weight] ?? "default"} className="uppercase">
                {m.weight}
              </Badge>
              <span className="text-muted-foreground tabular-nums">
                score {m.score.toFixed(2)}
              </span>
              {m.nodeRef ? (
                <a
                  href={`#${m.nodeRef}`}
                  className="ml-auto truncate font-mono text-[10px] text-foreground hover:underline"
                >
                  {m.nodeRef}
                </a>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap leading-relaxed">{m.lesson}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
