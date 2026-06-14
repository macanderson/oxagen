import * as React from "react";

/**
 * Inference-confidence meter for a semantic edge. Colour follows the product
 * thresholds (≥0.8 success · ≥0.6 warning · else danger). `score` is 0–1.
 */
export interface ConfidenceBarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Confidence in 0–1. */
  score: number;
  showValue?: boolean;
  width?: number;
}

export function ConfidenceBar(props: ConfidenceBarProps): React.ReactElement;
