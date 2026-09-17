/**
 * confidence-meter.tsx — a labelled bar for an inferred edge's 0..1 confidence.
 *
 * Colour bands: <0.5 amber (low), 0.5–0.8 sky (medium), ≥0.8 emerald (high).
 */

"use client";

import * as React from "react";
import { formatConfidence } from "./lib/format";

export interface ConfidenceMeterProps {
  confidence: number;
}

export function ConfidenceMeter({ confidence }: ConfidenceMeterProps) {
  const clamped = Math.max(0, Math.min(1, confidence));
  const pct = Math.round(clamped * 100);
  const color =
    clamped >= 0.8 ? "#10b981" : clamped >= 0.5 ? "#0ea5e9" : "#f59e0b";
  const band = clamped >= 0.8 ? "High" : clamped >= 0.5 ? "Medium" : "Low";

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {formatConfidence(clamped)}
        </span>
        <span className="text-xs text-muted-foreground">{band}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Inference confidence"
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
