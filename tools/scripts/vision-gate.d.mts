/**
 * Type declarations for vision-gate.mjs (kept as plain .mjs so CI can run it
 * with bare `node` — no install, no tsx — same pattern as check_manifest.mjs).
 */
export declare const COMMENT_MARKER: string;
export declare const MAX_DIFF_CHARS: number;
export declare const MAX_DOC_DIFF_CHARS: number;
export declare const VERDICTS: readonly string[];
export declare const DOC_DRIFT_QUESTION: string;

/** A doc or runbook claim that a control is on while the code leaves it off. */
export interface DocDriftFinding {
  file: string;
  claim: string;
  code: string;
}

export interface VisionVerdict {
  verdict: "advances" | "neutral" | "drifts" | "inconclusive";
  confidence: number;
  summary: string;
  reasons: string[];
  drift_flags: string[];
  recommendation: string;
  doc_drift: DocDriftFinding[];
}

export declare function isDocPath(path: string): boolean;
export declare function partitionDiff(patch: string): {
  product: string;
  docs: string;
};
export declare function truncateDiff(patch: string, limit?: number): string;
export declare function buildPrompt(
  vision: string,
  pr: { title?: string; body?: string },
  stat: string,
  patch: string,
): { system: string; user: string };
export declare function parseVerdict(text: unknown): VisionVerdict;
export declare function parseDocDrift(raw: unknown): DocDriftFinding[];
export declare function docDriftLine(finding: DocDriftFinding): string;
export declare function docDriftAnnotation(finding: DocDriftFinding): string;
export declare function renderComment(v: VisionVerdict, model: string): string;
export declare function shouldFail(v: VisionVerdict, strict: boolean): boolean;
