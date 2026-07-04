/**
 * Type declarations for vision-gate.mjs (kept as plain .mjs so CI can run it
 * with bare `node` — no install, no tsx — same pattern as check_manifest.mjs).
 */
export declare const COMMENT_MARKER: string;
export declare const MAX_DIFF_CHARS: number;
export declare const VERDICTS: readonly string[];

export interface VisionVerdict {
  verdict: "advances" | "neutral" | "drifts" | "inconclusive";
  confidence: number;
  summary: string;
  reasons: string[];
  drift_flags: string[];
  recommendation: string;
}

export declare function truncateDiff(patch: string, limit?: number): string;
export declare function buildPrompt(
  vision: string,
  pr: { title?: string; body?: string },
  stat: string,
  patch: string,
): { system: string; user: string };
export declare function parseVerdict(text: unknown): VisionVerdict;
export declare function renderComment(v: VisionVerdict, model: string): string;
export declare function shouldFail(v: VisionVerdict, strict: boolean): boolean;
